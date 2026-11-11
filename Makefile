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

# Installs and marks the extension enabled. The shell only discovers new
# extensions at login, so `gnome-extensions enable` fails for a fresh install;
# writing the setting directly makes it load already enabled at next login.
install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@en=$$(gsettings get org.gnome.shell enabled-extensions); \
	case "$$en" in *"'$(UUID)'"*) ;; \
	  "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['$(UUID)']" ;; \
	  *) gsettings set org.gnome.shell enabled-extensions "$${en%]}, '$(UUID)']" ;; \
	esac; \
	dis=$$(gsettings get org.gnome.shell disabled-extensions); \
	case "$$dis" in *"'$(UUID)'"*) \
	  dis=$$(echo "$$dis" | sed -e "s/'$(UUID)', //" -e "s/, '$(UUID)'//" -e "s/'$(UUID)'//"); \
	  gsettings set org.gnome.shell disabled-extensions "$$dis" ;; \
	esac
	@echo "Installed and enabled. Log out and back in to load it."

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
