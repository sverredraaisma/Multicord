# Writes throwaway self-signed certificates for one run of the live media
# check. Runs inside the Synapse image (which has `cryptography`), so the host
# needs no OpenSSL: python gencert.py <out dir> <name> <dns name>...
# Writes <name>.crt and <name>.key, valid for a day.
import datetime
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

out, name, *dns = sys.argv[1:]
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, dns[0])])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(subject)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(minutes=5))
    .not_valid_after(now + datetime.timedelta(days=1))
    .add_extension(x509.SubjectAlternativeName([x509.DNSName(d) for d in dns]), critical=False)
    .sign(key, hashes.SHA256())
)
with open(f"{out}/{name}.key", "wb") as f:
    f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
with open(f"{out}/{name}.crt", "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))
