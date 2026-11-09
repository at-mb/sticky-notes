import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {COLORS, MIN_FONT_SIZE, MAX_FONT_SIZE, getDataDir} from './util.js';

const LAYERS = ['above', 'desktop'];

export default class StickyNotesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window

        const page = new Adw.PreferencesPage();
        window.add(page);

        // ---- Behavior
        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behavior);

        const layerRow = new Adw.ComboRow({
            title: _('Notes Position'),
            subtitle: _('Above windows, or on the desktop behind them'),
            model: Gtk.StringList.new([_('Above windows'), _('On the desktop')]),
            selected: Math.max(0, LAYERS.indexOf(settings.get_string('layer'))),
        });
        layerRow.connect('notify::selected', () =>
            settings.set_string('layer', LAYERS[layerRow.selected]));
        settings.connect('changed::layer', () => {
            layerRow.selected = Math.max(0, LAYERS.indexOf(settings.get_string('layer')));
        });
        behavior.add(layerRow);

        const indicatorRow = new Adw.SwitchRow({title: _('Show Top Bar Icon')});
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(indicatorRow);

        // ---- New notes
        const defaults = new Adw.PreferencesGroup({title: _('New Notes')});
        page.add(defaults);

        const colorIds = COLORS.map(c => c.id);
        const colorRow = new Adw.ComboRow({
            title: _('Color'),
            model: Gtk.StringList.new(COLORS.map(c => _(c.name))),
            selected: Math.max(0, colorIds.indexOf(settings.get_string('default-color'))),
        });
        colorRow.connect('notify::selected', () =>
            settings.set_string('default-color', colorIds[colorRow.selected]));
        defaults.add(colorRow);

        const fontRow = Adw.SpinRow.new_with_range(MIN_FONT_SIZE, MAX_FONT_SIZE, 1);
        fontRow.title = _('Font Size (pt)');
        fontRow.value = settings.get_int('default-font-size');
        fontRow.connect('notify::value', () =>
            settings.set_int('default-font-size', Math.round(fontRow.value)));
        defaults.add(fontRow);

        // ---- Shortcuts
        const shortcuts = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
            description: _('Examples: &lt;Super&gt;&lt;Alt&gt;n, &lt;Control&gt;&lt;Alt&gt;s. Leave empty to disable.'),
        });
        page.add(shortcuts);

        shortcuts.add(this._shortcutRow(settings, 'new-note-shortcut',
            _('New Note'), 'toggle-shortcut'));
        shortcuts.add(this._shortcutRow(settings, 'toggle-shortcut',
            _('Show / Hide Notes'), 'new-note-shortcut'));

        // ---- Storage
        const storage = new Adw.PreferencesGroup({title: _('Storage')});
        page.add(storage);

        const folderRow = new Adw.ActionRow({
            title: _('Notes Folder'),
            subtitle: getDataDir(),
            subtitle_selectable: true,
        });
        const openButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Open Folder'),
            css_classes: ['flat'],
        });
        openButton.connect('clicked', () => {
            GLib.mkdir_with_parents(getDataDir(), 0o700);
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(getDataDir()).get_uri(), null);
        });
        folderRow.add_suffix(openButton);
        storage.add(folderRow);
    }

    /** An entry row editing the accelerator in `key`; it may not clash with `otherKey`. */
    _shortcutRow(settings, key, title, otherKey) {
        const row = new Adw.EntryRow({
            title,
            text: settings.get_strv(key)[0] ?? '',
            show_apply_button: true,
        });
        row.connect('apply', () => {
            const accel = row.text.trim();
            if (accel === '') {
                settings.set_strv(key, []);
                row.remove_css_class('error');
                return;
            }
            const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
            const clashes = settings.get_strv(otherKey).some(other => {
                const [otherOk, otherKeyval, otherMods] = Gtk.accelerator_parse(other);
                return otherOk && otherKeyval === keyval && otherMods === mods;
            });
            if (ok && keyval !== 0 && !clashes) {
                settings.set_strv(key, [accel]);
                row.remove_css_class('error');
            } else {
                row.add_css_class('error');
            }
        });
        return row;
    }
}
