package user

import (
	"fmd-server/constants"
	"fmd-server/metrics"
	"fmt"
)

func initializeUserMetrics(db *FMDDB) {
	var userCount int64
	db.DB.Model(&FMDUser{}).Count(&userCount)
	metrics.Accounts.Set(float64(userCount))

	var locationCount int64
	db.DB.Model(&Location{}).Count(&locationCount)
	metrics.Locations.Set(float64(locationCount))
	db.DB.Model(&DataV2{}).Where("type = ?", DataTypeLocation).Count(&locationCount)
	metrics.Locations.Add(float64(locationCount))

	var pictureCount int64
	db.DB.Model(&Picture{}).Count(&pictureCount)
	metrics.Pictures.Set(float64(pictureCount))
	db.DB.Model(&DataV2{}).Where("type = ?", DataTypePicture).Count(&pictureCount)
	metrics.Pictures.Add(float64(pictureCount))

	var pendingCommandCount int64
	db.DB.Model(&FMDUser{}).Where("command_to_user IS NOT NULL AND command_to_user <> ''").Count(&pendingCommandCount)
	metrics.PendingCommands.Set(float64(pendingCommandCount))
	db.DB.Model(&DataV2{}).Where("type = ?", DataTypeCommand).Count(&pendingCommandCount)
	metrics.PendingCommands.Add(float64(pendingCommandCount))

	var pendingMessageCount int64
	db.DB.Model(&Message{}).Count(&pendingMessageCount)
	metrics.PendingMessages.Set(float64(pendingMessageCount))

	for _, protoVersion := range constants.CryptoProtoVersions {
		var accountProtoCount int64
		db.DB.Model(&FMDUser{}).Where("crypto_proto_version = ?", protoVersion).Count(&accountProtoCount)
		metrics.AccountProto.WithLabelValues(fmt.Sprint(protoVersion)).Set(float64(accountProtoCount))
	}
}

func updateAccountProtoMetric(old, new uint16) {
	if old != new {
		metrics.AccountProto.WithLabelValues(fmt.Sprint(old)).Dec()
		metrics.AccountProto.WithLabelValues(fmt.Sprint(new)).Inc()
	}
}
