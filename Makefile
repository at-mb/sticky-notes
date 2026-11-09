UUID    = sticky-notes@osmanmb
SOURCES = extension.js note.js noteManager.js util.js prefs.js stylesheet.css metadata.json
ZIP     = $(UUID).shell-extension.zip

.PHONY: all pack install uninstall enable disable nested logs clean

all: pack

pack: $(ZIP)

$(ZIP): $(SOURCES) schemas/*.xml icons/*
	gnome-extensions pack --force \
		--extra-source=note.js \
		--extra-source=noteManager.js \
		--extra-source=util.js \
		--extra-source=icons \
		--schema=schemas/org.gnome.shell.extensions.sticky-notes.gschema.xml \
		.

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installed. On Wayland, log out and back in, then run: make enable"

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Test in a nested GNOME Shell window without logging out.
nested: install
	env -u GSETTINGS_SCHEMA_DIR MUTTER_DEBUG_DUMMY_MODE_SPECS=1366x768 dbus-run-session -- gnome-shell --nested --wayland

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(ZIP)
