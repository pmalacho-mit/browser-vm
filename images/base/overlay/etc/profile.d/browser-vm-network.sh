# HTTPS inside the VM terminates in the browser tab, with certificates from a
# CA made per tab (vm-init adds it to the system bundle). Tools that ship
# their own CA list need to be pointed at it:
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/browser-vm-ca.pem
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt PIP_CERT=/etc/ssl/certs/ca-certificates.crt
