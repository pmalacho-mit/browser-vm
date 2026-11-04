// tls.wasm: a TLS *server* that runs in the browser, next to the VM.
//
// The guest makes ordinary HTTPS connections. They never leave the tab: v86's
// emulated network hands the TCP stream to JavaScript, JavaScript feeds the
// ciphertext in here, and this module completes the handshake with a
// certificate for whatever hostname the guest asked for (SNI), signed by a CA
// generated fresh in this browser session and trusted only inside the guest.
// The decrypted HTTP request goes back to JavaScript, which replays it with
// the browser's fetch() (and the browser does the real TLS to the real site).
//
// This is the same design as container2wasm's in-browser network proxy.
// Build: GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o tls.wasm
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"sync"
	"syscall/js"
	"time"
)

var (
	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
	caPEM  string

	leafMu sync.Mutex
	leaves = map[string]*tls.Certificate{}
)

func serial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	return n
}

func makeCA() error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "Browser VM local CA (this tab only)", Organization: []string{"browser-linux-ide"}},
		NotBefore:             now.Add(-48 * time.Hour),
		NotAfter:              now.Add(30 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	caCert, _ = x509.ParseCertificate(der)
	caKey = key
	caPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return nil
}

// leafFor returns (and caches) a certificate for one hostname or IP.
func leafFor(name string) (*tls.Certificate, error) {
	if name == "" {
		return nil, errors.New("client sent no SNI; cannot pick a hostname")
	}
	leafMu.Lock()
	defer leafMu.Unlock()
	if c, ok := leaves[name]; ok {
		return c, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    now.Add(-24 * time.Hour),
		NotAfter:     now.Add(7 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(name); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{name}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	c := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	leaves[name] = c
	return c, nil
}

// pipeConn is the "network" side of one TLS session: ciphertext arrives from
// JavaScript via push() and leaves via the out callback.
type pipeConn struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    []byte
	closed bool
	out    js.Value
}

func newPipeConn(out js.Value) *pipeConn {
	c := &pipeConn{out: out}
	c.cond = sync.NewCond(&c.mu)
	return c
}

// push never blocks, so it is safe to call from a JS callback.
func (c *pipeConn) push(b []byte) {
	c.mu.Lock()
	c.buf = append(c.buf, b...)
	c.cond.Broadcast()
	c.mu.Unlock()
}

func (c *pipeConn) shut() {
	c.mu.Lock()
	c.closed = true
	c.cond.Broadcast()
	c.mu.Unlock()
}

func (c *pipeConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.buf) == 0 && !c.closed {
		c.cond.Wait()
	}
	if len(c.buf) == 0 {
		return 0, io.EOF
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *pipeConn) Write(p []byte) (int, error) {
	arr := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(arr, p)
	c.out.Invoke(arr)
	return len(p), nil
}

func (c *pipeConn) Close() error                     { c.shut(); return nil }
func (c *pipeConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (c *pipeConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (c *pipeConn) SetDeadline(time.Time) error      { return nil }
func (c *pipeConn) SetReadDeadline(time.Time) error  { return nil }
func (c *pipeConn) SetWriteDeadline(time.Time) error { return nil }

func bytesFrom(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

// accept(callbacks) -> { push(cipher), write(plain), close() }
//
// callbacks: cipher(Uint8Array)  ciphertext to send to the guest
//            hello(serverName)   handshake finished
//            plain(Uint8Array)   decrypted bytes from the guest
//            end(errorString)    guest side finished ("" = clean EOF)
//            closed()            our close_notify is out; close the TCP connection
func accept(this js.Value, args []js.Value) any {
	cb := args[0]
	pc := newPipeConn(cb.Get("cipher"))
	server := tls.Server(pc, &tls.Config{
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) { return leafFor(h.ServerName) },
		NextProtos:     []string{"http/1.1"}, // never negotiate h2: the proxy speaks HTTP/1.1
		MinVersion:     tls.VersionTLS12,
	})

	// Writes are queued and done by one goroutine, in order (a JS callback must not block).
	var wmu sync.Mutex
	wcond := sync.NewCond(&wmu)
	var wq [][]byte
	enqueue := func(b []byte) { wmu.Lock(); wq = append(wq, b); wcond.Broadcast(); wmu.Unlock() }

	go func() {
		if err := server.Handshake(); err != nil {
			cb.Call("end", "TLS handshake failed: "+err.Error())
			return
		}
		cb.Call("hello", server.ConnectionState().ServerName)
		go func() {
			for {
				wmu.Lock()
				for len(wq) == 0 {
					wcond.Wait()
				}
				b := wq[0]
				wq = wq[1:]
				wmu.Unlock()
				if b == nil {
					server.CloseWrite() // sends close_notify
					cb.Call("closed")
					return
				}
				if _, err := server.Write(b); err != nil {
					return
				}
			}
		}()
		buf := make([]byte, 32*1024)
		for {
			n, err := server.Read(buf)
			if n > 0 {
				arr := js.Global().Get("Uint8Array").New(n)
				js.CopyBytesToJS(arr, buf[:n])
				cb.Call("plain", arr)
			}
			if err != nil {
				msg := ""
				if err != io.EOF {
					msg = err.Error()
				}
				cb.Call("end", msg)
				return
			}
		}
	}()

	api := js.Global().Get("Object").New()
	api.Set("push", js.FuncOf(func(this js.Value, a []js.Value) any { pc.push(bytesFrom(a[0])); return nil }))
	api.Set("write", js.FuncOf(func(this js.Value, a []js.Value) any { enqueue(bytesFrom(a[0])); return nil }))
	api.Set("close", js.FuncOf(func(this js.Value, a []js.Value) any { enqueue(nil); return nil }))
	api.Set("abort", js.FuncOf(func(this js.Value, a []js.Value) any { pc.shut(); return nil }))
	return api
}

func main() {
	if err := makeCA(); err != nil {
		panic(err)
	}
	api := js.Global().Get("Object").New()
	api.Set("caPEM", caPEM)
	api.Set("accept", js.FuncOf(accept))
	js.Global().Set("__vmTLS", api)
	if ready := js.Global().Get("__vmTLSReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
