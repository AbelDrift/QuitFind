package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/spf13/viper"
)

// Config field keys

const CONF_DATABASE_DIR = "DatabaseDir"
const CONF_WEB_DIR = "WebDir"

const CONF_UNIX_SOCKET_PATH = "UnixSocketPath"
const CONF_UNIX_SOCKET_CHMOD = "UnixSocketChmod"

const CONF_PORT_SECURE = "PortSecure"
const CONF_PORT_INSECURE = "PortInsecure"

const CONF_MAX_SAVED_LOC = "MaxSavedLoc"
const CONF_MAX_SAVED_PIC = "MaxSavedPic"

const CONF_REGISTRATION_TOKEN = "RegistrationToken"

const CONF_SERVER_CERT = "ServerCrt"
const CONF_SERVER_KEY = "ServerKey"

const CONF_REMOTE_IP_HEADER = "RemoteIpHeader"

const CONF_TILE_SERVER_URL = "TileServerUrl"

const CONF_METRICS_ADDR_PORT = "MetricsAddrPort"

const CONF_LOG_LEVEL = "LogLevel"

// Default values

const DEF_TILE_SERVER_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

const DEF_MAX_LOC = 500
const DEF_MAX_PIC = 10

const MAX_SUPPORTED_MAX_LOC = 4000
const MAX_SUPPORTED_MAX_PIC = 100

// Set the default values for all config fields.
//
// See the descriptions in config.example.yml,
// And keep the default values in sync!.
func setDefaults(config *viper.Viper) {
	config.SetDefault(CONF_DATABASE_DIR, "./db/")
	config.SetDefault(CONF_WEB_DIR, "")

	config.SetDefault(CONF_UNIX_SOCKET_PATH, "")
	config.SetDefault(CONF_UNIX_SOCKET_CHMOD, 0600)

	config.SetDefault(CONF_PORT_SECURE, "8443")
	config.SetDefault(CONF_PORT_INSECURE, "8080")

	config.SetDefault(CONF_MAX_SAVED_LOC, DEF_MAX_LOC)
	config.SetDefault(CONF_MAX_SAVED_PIC, DEF_MAX_PIC)

	config.SetDefault(CONF_REGISTRATION_TOKEN, "")

	config.SetDefault(CONF_SERVER_CERT, "")
	config.SetDefault(CONF_SERVER_KEY, "")

	config.SetDefault(CONF_REMOTE_IP_HEADER, "")

	config.SetDefault(CONF_TILE_SERVER_URL, DEF_TILE_SERVER_URL)

	config.SetDefault(CONF_METRICS_ADDR_PORT, "[::1]:9100")

	config.SetDefault(CONF_LOG_LEVEL, "info")
}

// Initialise a config struct with all default values.
//
// This does NOT yet read the config file!
// It does set up the config struct to listen to env var changes.
func InitConfig() viper.Viper {
	// https://github.com/spf13/viper#viper-or-vipers
	config := viper.New()

	config.SetConfigName("config")
	config.SetConfigType("yaml")

	// Check env vars every time config.Get() is called
	config.SetEnvPrefix("fmd")
	config.AutomaticEnv()

	setDefaults(config)

	return *config
}

// Read the config file, either at the provided location, or at the default locations.
func ReadConfigFile(config *viper.Viper, configFilePath string) {
	useCustomPath := len(configFilePath) > 0

	if useCustomPath {
		config.SetConfigFile(configFilePath)
	} else {
		// If the admin has explicitly passed a path via the CLI flag,
		// DO NOT fall back to these locations.
		// Better to fail reading the file below to let the admin know something is wrong,
		// than silently using a different file (which can be hard to debug).
		//
		// Order matters! Config paths that are added first take priority.
		config.AddConfigPath("/etc/fmd-server/")
		config.AddConfigPath(".")
	}

	err := config.ReadInConfig()
	if err != nil {
		_, ok := err.(viper.ConfigFileNotFoundError)
		if ok && !useCustomPath {
			// use default values if default config files don't exist
			log.Warn().Msg("no config found, using defaults")
		} else {
			// fail to alert the admin
			log.Fatal().Err(err).Msg("failed to read config file")
		}
	}

	log.Info().
		Str("configFile", config.ConfigFileUsed()).
		Msg("using config")

	if config.ConfigFileUsed() == "/etc/fmd-server/config.yml" {
		mergeUserConfigFile(config)
	}

	// TODO: support auto-reload??
	// config.OnConfigChange(func(e fsnotify.Event) {
	// 	// TODO
	// })
	// config.WatchConfig()
}

// Merge the local.yml into the config.yml (when using /etc/fmd-server/).
//
// This is similar to how fail2ban uses jail.conf and jail.local:
// it allows packagers to use config.yml and allows admins put their settings in local.yml.
// Thus admins don't have to edit the packager's config.yml (which would
// cause conflicts if a package update changes the config.yml).
//
// Values in local.yml override their counterpart in config.yml.
func mergeUserConfigFile(config *viper.Viper) {
	local := viper.New()

	// We cannot use SetConfigFile() because then the ConfigFileNotFoundError trick below does not work
	local.AddConfigPath("/etc/fmd-server/")
	local.SetConfigName("local")
	local.SetConfigType("yaml")

	err := local.ReadInConfig()
	if err != nil {
		_, ok := err.(viper.ConfigFileNotFoundError)
		if !ok {
			// fail to alert the admin
			log.Fatal().Err(err).Msg("failed to read /etc/fmd-server/local.yml")
		}
		return
	}

	// Merge the local settings into the global config.
	// Local settings override global settings!
	config.MergeConfigMap(local.AllSettings())
}

func ValidateConfigContent(config *viper.Viper) {
	maxLoc := config.GetInt(CONF_MAX_SAVED_LOC)
	if maxLoc >= MAX_SUPPORTED_MAX_LOC {
		log.Warn().Msg(fmt.Sprintf("config: %s=%d is too large! recommended=%d, max_supported=%d", CONF_MAX_SAVED_LOC, maxLoc, DEF_MAX_LOC, MAX_SUPPORTED_MAX_LOC))
	}

	maxPic := config.GetInt(CONF_MAX_SAVED_PIC)
	if maxPic >= MAX_SUPPORTED_MAX_PIC {
		log.Warn().Msg(fmt.Sprintf("config: %s=%d is too large! recommended=%d, max_supported=%d", CONF_MAX_SAVED_PIC, maxPic, DEF_MAX_PIC, MAX_SUPPORTED_MAX_PIC))
	}

	// Removed in https://gitlab.com/fmd-foss/fmd-server/-/merge_requests/256
	if config.GetInt("UserIdLength") != 0 {
		log.Warn().Msg("config: UserIdLength has no effect since 0.17.0 and can be removed")
	}
}

// Validate the tile server URL.
// Returns both the original raw URL and the origin (suitable for putting in a CSP).
//
// Expected input is something like:
// https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png
func ValidateTileServerUrl(raw string) (string, string) {
	if raw == "" {
		raw = DEF_TILE_SERVER_URL
	}

	// url.Parse fails on {s} because that is not a valid domain name,
	// Replace it with a wildcard domain, since the CSP needs that anyway.
	cleanDomain := strings.Replace(raw, "{s}", "*", 1)

	// Check that (apart from the {s} template) this is a valid URL
	u, err := url.Parse(cleanDomain)
	if err != nil {
		log.Fatal().Err(err).Msg("TileServerUrl is not a valid URL")
		os.Exit(1) // make nilaway happy
	}
	if u.Scheme == "" {
		log.Warn().
			Str("TileServerUrl", u.String()).
			Msg("TileServerUrl has no scheme")
	}
	if u.Host == "" {
		log.Warn().
			Str("TileServerUrl", u.String()).
			Msg("TileServerUrl has no host")
	}

	// Origin == scheme, hostname, port (u.Host includes the port)
	origin := u.Scheme + "://" + u.Host

	return raw, origin
}

func GetLogLevel(config *viper.Viper) zerolog.Level {
	levelStr := config.GetString(CONF_LOG_LEVEL)
	level, err := zerolog.ParseLevel(levelStr)
	if err != nil {
		log.Error().Str("string", levelStr).Msg("failed to parse log level")
		return zerolog.InfoLevel
	}
	return level
}
