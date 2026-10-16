/** Network failures in words a user can act on, by Chromium's error code (without "net::"). */
const NET_ERRORS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "the server's address could not be found; check your internet connection",
  ERR_INTERNET_DISCONNECTED: "there is no internet connection",
  ERR_NETWORK_CHANGED: "the network connection changed; try again",
  ERR_ADDRESS_UNREACHABLE: "the server cannot be reached from this network",
  ERR_CONNECTION_REFUSED: "the server refused the connection",
  ERR_CONNECTION_RESET: "the connection to the server was interrupted; try again",
  ERR_CONNECTION_CLOSED: "the connection to the server was interrupted; try again",
  ERR_CONNECTION_TIMED_OUT: "the server did not answer in time",
  ERR_TIMED_OUT: "the server did not answer in time",
  ERR_CERT_AUTHORITY_INVALID: "the server's certificate is not trusted",
  ERR_CERT_DATE_INVALID: "the server's certificate has expired or is not yet valid",
};

/** A network error code (ERR_NAME_NOT_RESOLVED) in plain words; undefined for codes without any. */
export function netErrorText(code: string): string | undefined {
  return Object.hasOwn(NET_ERRORS, code) ? NET_ERRORS[code] : undefined;
}
