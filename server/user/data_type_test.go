package user

import "testing"

// QuitFind: the device register is a separate data type that is never pruned.
func TestParseDataTypeDevice(t *testing.T) {
	typ, err := ParseDataType("device")
	if err != nil || typ != DataTypeDevice {
		t.Fatalf("ParseDataType(device) = %v, %v", typ, err)
	}
	if _, err := ParseDataType("devices"); err == nil {
		t.Fatal("expected an error for an unknown type")
	}
}

func TestDeviceRegisterIsNeverPruned(t *testing.T) {
	u := &UserRepository{maxSavedLoc: 1, maxSavedPic: 1}
	if n := u.getNumToKeep(DataTypeDevice); n != KEEP_ALL {
		t.Fatalf("getNumToKeep(device) = %d, want KEEP_ALL", n)
	}
	if n := u.getNumToKeep(DataTypeLocation); n != 1 {
		t.Fatalf("getNumToKeep(location) = %d, want 1", n)
	}
	if getDataMetric(DataTypeDevice) == nil {
		t.Fatal("device type needs its own metric")
	}
}
