import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Note} from './note.js';
import {getDataDir, getNotesPath, startOfDay, DUE_SOON_SECONDS} from './util.js';

const SAVE_DELAY_MS = 600;
const DEFAULT_WIDTH = 260;
const DEFAULT_HEIGHT = 240;
const CASCADE_OFFSET = 32;
// Deadlines aren't polled: a single timer wakes up at the next moment a note's
// deadline display changes (deadline reached, due soon, or midnight, when
// "Tomorrow" becomes "Today"). The timer is capped so a changed system clock
// is picked up within the hour, and is re-armed after resuming from suspend.
const MAX_DEADLINE_CHECK_SECONDS = 60 * 60;

/**
 * Whether a window is part of the desktop: a real desktop window, or one the
 * Desktop Icons (DING) extension keeps at the bottom. DING's windows have the
 * application id "com.rastersoft.ding" and a title that is either
 * "Desktop Icons N" or like "@!0,0;BDHF" (B = keep at bottom), depending on
 * the version and on whether they have been resized yet.
 */
function isDesktopWindow(window) {
    if (!window)
        return false;
    if (window.get_window_type() === Meta.WindowType.DESKTOP)
        return true;
    // Set by the DING extension itself on the windows it keeps at the bottom.
    if (window.customJS_ding?.keepAtBottom)
        return true;
    if (window.get_gtk_application_id?.() === 'com.rastersoft.ding')
        return true;
    const title = window.get_title() ?? '';
    if (title.startsWith('Desktop Icons '))
        return true;
    const flags = title.match(/@!-?\d+,-?\d+;([A-Z]*)/)?.[1] ?? '';
    return flags.includes('B') && !flags.includes('T');
}

/**
 * Owns all notes: loading/saving them, placing them in the right layer
 * (above windows or on the desktop) and showing/hiding them.
 */
export class NoteManager {
    constructor(extension, settings) {
        this.extensionPath = extension.path;
        this._settings = settings;
        this._notes = []; // kept in stacking order, last = topmost
        this._saveSourceId = 0;
        this._deadlineSourceId = 0;
        this._notificationSource = null;
        this._inOverview = Main.overview.visible;
        this._layer = this._settings.get_string('layer');
        this._file = Gio.File.new_for_path(getNotesPath());

        for (const data of this._load())
            this._addNote(data);

        this._settings.connectObject(
            'changed::notes-visible', () => this._syncVisibility(),
            'changed::layer', () => this._setLayer(this._settings.get_string('layer')),
            this);

        Main.overview.connectObject(
            'showing', () => {
                this._inOverview = true;
                this._syncVisibility();
            },
            'hidden', () => {
                this._inOverview = false;
                this._syncVisibility();
            },
            this);

        global.display.connectObject('in-fullscreen-changed',
            () => this._syncVisibility(), this);

        Main.layoutManager.connectObject('monitors-changed', () => {
            for (const note of this._notes) {
                const [x, y] = this.clampPosition(note.actor.x, note.actor.y, note.actor.width);
                note.actor.set_position(x, y);
            }
            this._syncVisibility();
        }, this);

        // Mutter restacks window actors (lowering them all below any other
        // child of the window group, i.e. below our notes) whenever the window
        // stack changes: put desktop-layer notes back just above the desktop.
        global.display.connectObject('restacked', () => {
            if (this._layer === 'desktop')
                this._restackDesktop();
        }, this);

        this._syncVisibility();

        // Timers don't run during suspend: check again right after waking up.
        LoginManager.getLoginManager().connectObject('prepare-for-sleep',
            (loginManager, aboutToSuspend) => {
                if (!aboutToSuspend)
                    this._checkDeadlines();
            }, this);

        // Also notifies about deadlines that passed while the extension was off.
        this._checkDeadlines();
    }

    // ---- Public API ------------------------------------------------------

    get visible() {
        return this._settings.get_boolean('notes-visible');
    }

    set visible(value) {
        this._settings.set_boolean('notes-visible', value);
    }

    /** Called by a note when its deadline is set or removed. */
    deadlinesChanged() {
        this._checkDeadlines();
    }

    get isEmpty() {
        return this._notes.length === 0;
    }

    hasNote(note) {
        return this._notes.includes(note);
    }

    toggle() {
        this.visible = !this.visible;
        if (this.visible && this._notes.length === 0)
            this.createNote();
    }

    createNote({near = null} = {}) {
        let x, y, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT;

        if (near) {
            width = near.actor.width;
            height = near.actor.height;
            x = near.actor.x + CASCADE_OFFSET;
            y = near.actor.y + CASCADE_OFFSET;
        } else {
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const step = (this._notes.length % 6) * CASCADE_OFFSET;
            x = area.x + (area.width - width) / 2 + step;
            y = area.y + (area.height - height) / 2 + step;
        }
        [x, y] = this.clampPosition(x, y, width);

        const note = this._addNote({
            id: GLib.uuid_string_random(),
            x,
            y,
            width,
            height,
            color: this._settings.get_string('default-color'),
            fontSize: this._settings.get_int('default-font-size'),
            text: '',
            deadline: null,
            deadlineNotified: false,
        });

        if (!this.visible)
            this.visible = true;
        else
            this._syncVisibility();

        note.focus();
        this.scheduleSave();
        return note;
    }

    deleteNote(note) {
        const index = this._notes.indexOf(note);
        if (index < 0)
            return;
        this._notes.splice(index, 1);
        this._detach(note);
        note.destroy();
        this.scheduleSave();
    }

    raise(note) {
        const index = this._notes.indexOf(note);
        if (index < 0 || index === this._notes.length - 1)
            return;
        this._notes.splice(index, 1);
        this._notes.push(note);
        this._raiseActor(note);
        this.scheduleSave();
    }

    /** Keep at least part of the header on screen so a note can always be grabbed back. */
    clampPosition(x, y, width) {
        const margin = 48;
        const stageW = global.stage.width;
        const stageH = global.stage.height;
        return [
            Math.round(Math.clamp(x, margin - width, stageW - margin)),
            Math.round(Math.clamp(y, 0, stageH - margin)),
        ];
    }

    scheduleSave() {
        if (this._saveSourceId)
            return;
        this._saveSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveSourceId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._saveSourceId) {
            GLib.source_remove(this._saveSourceId);
            this._saveSourceId = 0;
        }
        if (this._deadlineSourceId) {
            GLib.source_remove(this._deadlineSourceId);
            this._deadlineSourceId = 0;
        }
        this._save();
        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._settings.disconnectObject(this);
        LoginManager.getLoginManager().disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);

        for (const note of this._notes) {
            this._detach(note);
            note.destroy();
        }
        this._notes = [];
        this._settings = null;
    }

    // ---- Layers ----------------------------------------------------------

    _addNote(data) {
        const note = new Note(this, data);
        this._notes.push(note);
        this._attach(note);
        return note;
    }

    _attach(note) {
        note._layer = this._layer;
        if (this._layer === 'desktop') {
            // In the window group, right above the wallpaper and any desktop
            // window (e.g. the Desktop Icons extension's full-screen window,
            // which would otherwise swallow every click on the notes), but
            // below normal windows.
            global.window_group.add_child(note.actor);
            this._restackDesktop();
        } else {
            // Above windows, but below the top bar, popup menus and modal dialogs.
            Main.layoutManager.uiGroup.insert_child_below(note.actor, Main.layoutManager.panelBox);
            Main.layoutManager.trackChrome(note.actor, {affectsInputRegion: true});
        }
    }

    _detach(note) {
        const parent = note.actor.get_parent();
        if (!parent)
            return;
        if (note._layer === 'above')
            Main.layoutManager.untrackChrome(note.actor);
        parent.remove_child(note.actor);
        note._layer = null;
    }

    _raiseActor(note) {
        if (note._layer === 'desktop')
            this._restackDesktop();
        else
            Main.layoutManager.uiGroup.set_child_below_sibling(note.actor, Main.layoutManager.panelBox);
    }

    /**
     * The topmost desktop window actor (wallpaper group if none).
     *
     * This deliberately walks the window group's children instead of calling
     * global.get_window_actors(): on Wayland the Desktop Icons (DING)
     * extension overrides that function to hide its own full-screen window.
     * Relying on it put the notes *below* DING's transparent window, which
     * then swallowed every click on them.
     */
    _desktopAnchor() {
        let anchor = Main.layoutManager._backgroundGroup;
        for (const actor of global.window_group.get_children()) {
            if (actor instanceof Meta.WindowActor && isDesktopWindow(actor.get_meta_window()))
                anchor = actor;
        }
        return anchor;
    }

    /** Stacks desktop-layer notes, in order, directly above the desktop. */
    _restackDesktop() {
        let below = this._desktopAnchor();
        this._logAnchor(below);
        if (below.get_parent() !== global.window_group)
            below = null;
        for (const note of this._notes) {
            if (note.actor.get_parent() !== global.window_group)
                continue;
            if (below)
                global.window_group.set_child_above_sibling(note.actor, below);
            else
                global.window_group.set_child_below_sibling(note.actor, null);
            below = note.actor;
        }
    }

    /** Logs (only when it changes) what desktop-layer notes are stacked above. */
    _logAnchor(anchor) {
        const window = anchor instanceof Meta.WindowActor ? anchor.get_meta_window() : null;
        const description = window
            ? `desktop window "${window.get_title()}" (${window.get_gtk_application_id?.() ?? 'no app id'})`
            : 'the wallpaper (no desktop window found)';
        if (description === this._lastAnchor)
            return;
        this._lastAnchor = description;
        console.log(`Sticky Notes: desktop-layer notes stacked above ${description}`);
    }

    _setLayer(layer) {
        if (layer === this._layer)
            return;
        const focused = this._notes.find(n => n.hasKeyFocus());
        for (const note of this._notes)
            this._detach(note);
        this._layer = layer;
        for (const note of this._notes)
            this._attach(note);
        this._syncVisibility();
        focused?.focus();
    }

    _syncVisibility() {
        const above = this._layer === 'above';
        // Windows (and the desktop layer with them) are hidden in the overview anyway.
        const show = this.visible && !(above && this._inOverview);

        for (const note of this._notes) {
            let visible = show;
            if (visible && above) {
                const monitor = Main.layoutManager.findMonitorForActor(note.actor);
                if (monitor?.inFullscreen)
                    visible = false;
            }
            if (!visible && note.hasKeyFocus())
                global.stage.set_key_focus(null);
            note.actor.visible = visible;
        }
    }

    // ---- Deadlines -------------------------------------------------------

    _checkDeadlines() {
        const now = GLib.DateTime.new_now_local();
        for (const note of this._notes) {
            if (note.deadline === null)
                continue;
            note.updateDeadline(now);
            if (note.isOverdue(now) && !note.deadlineNotified) {
                note.deadlineNotified = true;
                this._notifyDeadline(note);
                this.scheduleSave();
            }
        }
        this._scheduleDeadlineCheck(now);
    }

    _scheduleDeadlineCheck(now) {
        if (this._deadlineSourceId) {
            GLib.source_remove(this._deadlineSourceId);
            this._deadlineSourceId = 0;
        }

        const deadlines = this._notes.map(n => n.deadline).filter(d => d !== null);
        if (deadlines.length === 0)
            return;

        const nowUnix = now.to_unix();
        // Labels say "Today" / "Tomorrow" / "Yesterday", which change at midnight.
        let next = startOfDay(now).add_days(1).to_unix();
        for (const deadline of deadlines) {
            for (const moment of [deadline - DUE_SOON_SECONDS, deadline]) {
                if (moment > nowUnix)
                    next = Math.min(next, moment);
            }
        }

        // +1: second-granularity timers may fire a little early.
        const delay = Math.clamp(next - nowUnix + 1, 1, MAX_DEADLINE_CHECK_SECONDS);
        this._deadlineSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._deadlineSourceId = 0;
            this._checkDeadlines();
            return GLib.SOURCE_REMOVE;
        });
    }

    _notifyDeadline(note) {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: _('Sticky Notes'),
                iconName: 'alarm-symbolic',
            });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }

        const notification = new MessageTray.Notification({
            source: this._notificationSource,
            title: _('Deadline reached'),
            body: note.title || _('A sticky note is due'),
        });
        // Clicking the notification shows the note.
        notification.connect('activated', () => {
            if (!this.hasNote(note))
                return;
            Main.overview.hide();
            this.visible = true;
            this.raise(note);
            note.focus();
        });
        this._notificationSource.addNotification(notification);
    }

    // ---- Storage ---------------------------------------------------------

    _load() {
        let contents;
        try {
            [, contents] = this._file.load_contents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`Sticky Notes: could not read ${this._file.get_path()}: ${e.message}`);
            return [];
        }

        try {
            const parsed = JSON.parse(new TextDecoder().decode(contents));
            const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
            return notes.filter(n => n && typeof n.id === 'string').map(n => ({
                id: n.id,
                x: Number(n.x) || 0,
                y: Number(n.y) || 0,
                width: Number(n.width) || DEFAULT_WIDTH,
                height: Number(n.height) || DEFAULT_HEIGHT,
                color: String(n.color ?? ''),
                fontSize: Number(n.fontSize) || 12,
                text: String(n.text ?? ''),
                deadline: Number.isFinite(n.deadline) ? Math.round(n.deadline) : null,
                deadlineNotified: Boolean(n.deadlineNotified),
            }));
        } catch (e) {
            // Never overwrite a file we failed to parse: move it aside first.
            const backup = `${this._file.get_path()}.broken-${Date.now()}`;
            console.error(`Sticky Notes: invalid notes file, moved to ${backup}: ${e.message}`);
            try {
                this._file.move(Gio.File.new_for_path(backup), Gio.FileCopyFlags.NONE, null, null);
            } catch (moveError) {
                console.error(`Sticky Notes: could not back up notes file: ${moveError.message}`);
            }
            return [];
        }
    }

    _save() {
        const json = JSON.stringify({
            version: 1,
            notes: this._notes.map(n => n.serialize()),
        }, null, 2);

        try {
            GLib.mkdir_with_parents(getDataDir(), 0o700);
            // replace_contents writes to a temp file and renames it, so a crash
            // mid-write can't leave a truncated notes file behind.
            this._file.replace_contents(new TextEncoder().encode(json), null, false,
                Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            console.error(`Sticky Notes: could not save notes: ${e.message}`);
        }
    }
}
