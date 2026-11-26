package constants

const VERSION = "0.17.1"

const (
	CryptoProtoV1 uint16 = 1
	CryptoProtoV2 uint16 = 2
)

// "var" instead of "const", because Go doesn't have constant arrays :/
var CryptoProtoVersions = [...]uint16{CryptoProtoV1, CryptoProtoV2}
