// vm-agent: the VM's control plane. Runs as /sbin/vm-agent (started by
// vm-init) with stdin/stdout on /dev/ttyS1, and talks to the extension in JSON
// lines, one object per line:
//
//	→ {"id":"7","cmd":"resize","tty":"ttyS0","rows":40,"cols":120}
//	← {"id":"7","ok":true}
//	← {"id":"8","ok":false,"error":"…"}
//	← {"event":"ready","kernel":"6.18.0","agent":2}        once, at start
//
// Commands: ping, resize, hangup, exec, ports, refresh (see the handlers).
// The runtime writes this binary into the guest before boot
// (runtime/src/vm.ts), so it doesn't depend on the image; images still ship
// the shell agent (runtime/guest/vm-agent) as a fallback.
//
// Build: npm run agent (static, no cgo, for 386 and amd64).
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Version of the JSON protocol, reported in the ready event.
const protocolVersion = 2

// Max bytes of stdout and of stderr returned by exec.
const maxOutput = 8 << 20

type request struct {
	ID   string `json:"id"`
	Cmd  string `json:"cmd"`
	TTY  string `json:"tty,omitempty"`
	Rows int    `json:"rows,omitempty"`
	Cols int    `json:"cols,omitempty"`
	// exec
	Argv      []string          `json:"argv,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Stdin     string            `json:"stdin,omitempty"` // base64
	TimeoutMs int               `json:"timeoutMs,omitempty"`
	// refresh
	Seed   string `json:"seed,omitempty"`   // base64 random bytes from the host
	TimeMs int64  `json:"timeMs,omitempty"` // host clock, ms since the epoch
}

type response map[string]any

var (
	outMu sync.Mutex
	out   = bufio.NewWriter(os.Stdout)
)

func send(r response) {
	b, err := json.Marshal(r)
	if err != nil {
		b, _ = json.Marshal(response{"id": r["id"], "ok": false, "error": err.Error()})
	}
	outMu.Lock()
	defer outMu.Unlock()
	out.Write(b)
	out.WriteByte('\n')
	out.Flush()
}

func main() {
	send(response{"event": "ready", "kernel": kernelRelease(), "agent": protocolVersion})
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64<<10), 64<<20) // exec stdin can be large
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			send(response{"ok": false, "error": "bad request: " + err.Error()})
			continue
		}
		// Each request runs on its own goroutine, so a long exec doesn't block resize.
		go func() {
			res, err := handle(req)
			if res == nil {
				res = response{}
			}
			res["id"] = req.ID
			if err != nil {
				res["ok"] = false
				res["error"] = err.Error()
			} else {
				res["ok"] = true
			}
			send(res)
		}()
	}
}

func handle(r request) (response, error) {
	switch r.Cmd {
	case "ping":
		return response{"pong": true}, nil
	case "resize":
		return nil, resize(r.TTY, r.Rows, r.Cols)
	case "hangup":
		n, err := hangup(r.TTY)
		return response{"signaled": n}, err
	case "exec":
		return run(r)
	case "ports":
		p, err := listeningPorts()
		return response{"ports": p}, err
	case "refresh":
		return refresh(r)
	default:
		return nil, fmt.Errorf("unknown command %q", r.Cmd)
	}
}

func kernelRelease() string {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(b))
}

// ttyPath accepts "ttyS0" and refuses anything that isn't a plain device name.
func ttyPath(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "/.") {
		return "", fmt.Errorf("invalid tty %q", name)
	}
	return "/dev/" + name, nil
}

// resize sets a console's window size (TIOCSWINSZ). The kernel then sends
// SIGWINCH to the foreground job, so vim/less/top re-layout themselves.
func resize(tty string, rows, cols int) error {
	path, err := ttyPath(tty)
	if err != nil {
		return err
	}
	if rows <= 0 || cols <= 0 || rows > 10000 || cols > 10000 {
		return fmt.Errorf("invalid size %dx%d", cols, rows)
	}
	f, err := os.OpenFile(path, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	ws := struct{ Row, Col, X, Y uint16 }{uint16(rows), uint16(cols), 0, 0}
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws))); e != 0 {
		return e
	}
	return nil
}

// hangup sends SIGHUP to every process whose controlling terminal is the
// console, like closing an SSH session. vm-init then starts a fresh shell.
func hangup(tty string) (int, error) {
	path, err := ttyPath(tty)
	if err != nil {
		return 0, err
	}
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return 0, err
	}
	// st_rdev and tty_nr in /proc/<pid>/stat use the same encoding
	// (minor bits 0-7 and 20-31, major bits 8-19), so compare them directly.
	want := int64(st.Rdev)
	pids, _ := filepath.Glob("/proc/[0-9]*/stat")
	n := 0
	for _, statPath := range pids {
		b, err := os.ReadFile(statPath)
		if err != nil {
			continue // the process exited
		}
		// Fields after "(comm) ": state ppid pgrp session tty_nr ...
		s := string(b)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		f := strings.Fields(s[i+1:])
		if len(f) < 5 {
			continue
		}
		ttyNr, err := strconv.ParseInt(f[4], 10, 64)
		if err != nil || ttyNr != want {
			continue
		}
		pid, err := strconv.Atoi(filepath.Base(filepath.Dir(statPath)))
		if err == nil && pid != os.Getpid() && syscall.Kill(pid, syscall.SIGHUP) == nil {
			n++
		}
	}
	return n, nil
}

// cappedBuffer keeps the first max bytes written to it and counts the rest.
type cappedBuffer struct {
	bytes.Buffer
	max       int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room > 0 {
		if len(p) > room {
			c.Buffer.Write(p[:room])
			c.truncated = true
		} else {
			c.Buffer.Write(p)
		}
	} else if len(p) > 0 {
		c.truncated = true
	}
	return len(p), nil
}

// run executes argv (no shell), waiting for it to exit.
func run(r request) (response, error) {
	if len(r.Argv) == 0 {
		return nil, errors.New("exec needs argv")
	}
	ctx := context.Background()
	if r.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(r.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, r.Argv[0], r.Argv[1:]...)
	cmd.Dir = r.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/root/project"
	}
	cmd.Env = append(os.Environ(), "HOME=/root", "TERM=dumb")
	for k, v := range r.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if r.Stdin != "" {
		in, err := base64.StdEncoding.DecodeString(r.Stdin)
		if err != nil {
			return nil, fmt.Errorf("stdin: %w", err)
		}
		cmd.Stdin = bytes.NewReader(in)
	}
	stdout, stderr := &cappedBuffer{max: maxOutput}, &cappedBuffer{max: maxOutput}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	start := time.Now()
	err := cmd.Run()
	code := 0
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode() // -1 if killed by a signal (e.g. the timeout)
	default:
		return nil, err // could not start
	}
	res := response{
		"code":     code,
		"stdout":   base64.StdEncoding.EncodeToString(stdout.Bytes()),
		"stderr":   base64.StdEncoding.EncodeToString(stderr.Bytes()),
		"ms":       time.Since(start).Milliseconds(),
		"timedOut": ctx.Err() != nil,
	}
	if stdout.truncated || stderr.truncated {
		res["truncated"] = true
	}
	return res, nil
}

// listeningPorts lists TCP ports with a socket in LISTEN state, from /proc/net/tcp{,6}.
func listeningPorts() ([]int, error) {
	seen := map[int]bool{}
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue // no IPv6 in the kernel config
		}
		for _, line := range strings.Split(string(b), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) < 4 || fields[3] != "0A" { // 0A = TCP_LISTEN
				continue
			}
			local := fields[1] // hex address:port
			i := strings.LastIndexByte(local, ':')
			if p, err := strconv.ParseUint(local[i+1:], 16, 16); err == nil {
				seen[int(p)] = true
			}
		}
	}
	ports := make([]int, 0, len(seen))
	for p := range seen {
		ports = append(ports, p)
	}
	sort.Ints(ports)
	return ports, nil
}

// The tab's CA certificate (written by the extension) and the system bundle it joins.
const (
	tabCA        = "/etc/ssl/certs/browser-vm-ca.pem"
	caBundle     = "/etc/ssl/certs/ca-certificates.crt"
	tabCASubject = "Browser VM local CA" // in every tab CA's subject (runtime/tls/main.go)
)

// refresh brings a VM restored from a snapshot up to date with this tab:
//   - mixes fresh host randomness into the kernel's pool (every copy of a
//     snapshot starts with the same entropy pool);
//   - sets the clock (the snapshot's clock stopped when it was saved);
//   - replaces the old tab's CA in the system bundle with this tab's.
func refresh(r request) (response, error) {
	res := response{}
	if r.Seed != "" {
		seed, err := base64.StdEncoding.DecodeString(r.Seed)
		if err != nil {
			return nil, fmt.Errorf("seed: %w", err)
		}
		// Writing to /dev/urandom mixes the bytes into the pool.
		if err := os.WriteFile("/dev/urandom", seed, 0); err != nil {
			return nil, fmt.Errorf("seed: %w", err)
		}
		res["seeded"] = len(seed)
	}
	if r.TimeMs > 0 {
		tv := syscall.NsecToTimeval(r.TimeMs * int64(time.Millisecond))
		if err := syscall.Settimeofday(&tv); err != nil {
			return nil, fmt.Errorf("clock: %w", err)
		}
		res["clock"] = time.UnixMilli(r.TimeMs).UTC().Format(time.RFC3339)
	}
	if n, err := rebuildCABundle(); err != nil {
		return nil, fmt.Errorf("CA bundle: %w", err)
	} else {
		res["caReplaced"] = n
	}
	return res, nil
}

// rebuildCABundle drops every earlier tab CA from the system bundle and appends
// the current one. Returns how many old ones were removed (-1: nothing to do).
func rebuildCABundle() (int, error) {
	ca, err := os.ReadFile(tabCA)
	if err != nil || len(bytes.TrimSpace(ca)) == 0 {
		return -1, nil // networking off: no tab CA
	}
	bundle, err := os.ReadFile(caBundle)
	if err != nil {
		return -1, nil // image without a CA bundle
	}
	var kept bytes.Buffer
	removed := 0
	rest := bundle
	for {
		block, next := pem.Decode(rest)
		if block == nil {
			break
		}
		// The subject is plain text inside the DER, so no X.509 parser is needed.
		if block.Type == "CERTIFICATE" && bytes.Contains(block.Bytes, []byte(tabCASubject)) {
			removed++
		} else {
			pem.Encode(&kept, block)
		}
		rest = next
	}
	kept.Write(bytes.TrimSpace(ca))
	kept.WriteByte('\n')
	tmp := caBundle + ".tmp"
	if err := os.WriteFile(tmp, kept.Bytes(), 0o644); err != nil {
		return 0, err
	}
	return removed, os.Rename(tmp, caBundle)
}
