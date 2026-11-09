import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NoteManager} from './noteManager.js';

const NotesIndicator = GObject.registerClass(
class NotesIndicator extends PanelMenu.Button {
    _init(extension, settings, manager) {
        super._init(0.0, _('Sticky Notes'));

        this.add_child(new St.Icon({
            icon_name: 'document-edit-symbolic',
            style_class: 'system-status-icon',
        }));

        const visibleItem = new PopupMenu.PopupSwitchMenuItem(_('Show Notes'),
            settings.get_boolean('notes-visible'));
        visibleItem.connect('toggled', (item, state) => {
            manager.visible = state;
            if (state && manager.isEmpty)
                manager.createNote();
        });
        this.menu.addMenuItem(visibleItem);

        const aboveItem = new PopupMenu.PopupSwitchMenuItem(_('Keep Above Windows'),
            settings.get_string('layer') === 'above');
        aboveItem.connect('toggled', (item, state) =>
            settings.set_string('layer', state ? 'above' : 'desktop'));
        this.menu.addMenuItem(aboveItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction(_('New Note'), () => manager.createNote());
        this.menu.addAction(_('Preferences'), () => extension.openPreferences());

        settings.connectObject(
            'changed::notes-visible', () =>
                visibleItem.setToggleState(settings.get_boolean('notes-visible')),
            'changed::layer', () =>
                aboveItem.setToggleState(settings.get_string('layer') === 'above'),
            this);
    }
});

export default class StickyNotesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new NoteManager(this, this._settings);

        this._settings.connectObject('changed::show-indicator',
            () => this._syncIndicator(), this);
        this._syncIndicator();

        Main.wm.addKeybinding('new-note-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._newNote());
        Main.wm.addKeybinding('toggle-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._manager.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('new-note-shortcut');
        Main.wm.removeKeybinding('toggle-shortcut');
        Main.overview.disconnectObject(this);

        this._settings.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;

        this._manager.destroy();
        this._manager = null;
        this._settings = null;
    }

    _newNote() {
        const note = this._manager.createNote();
        if (!Main.overview.visible)
            return;

        // Notes aren't shown in the Overview: leave it, then focus the new note.
        Main.overview.disconnectObject(this);
        Main.overview.connectObject('hidden', () => {
            Main.overview.disconnectObject(this);
            if (this._manager?.hasNote(note))
                note.focus();
        }, this);
        Main.overview.hide();
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new NotesIndicator(this, this._settings, this._manager);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
