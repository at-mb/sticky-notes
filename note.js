import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    COLORS, getColor, MIN_FONT_SIZE, MAX_FONT_SIZE,
    parseDeadline, suggestDeadline, formatDeadline, formatDeadlineInput, DUE_SOON_SECONDS,
} from './util.js';

export const MIN_WIDTH = 190;
export const MIN_HEIGHT = 110;

// ---- Compatibility across GNOME versions ------------------------------

// St.BoxLayout:vertical was replaced by :orientation in GNOME 48 and removed in 51.
const VERTICAL = GObject.Object.find_property.call(St.BoxLayout, 'orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

/**
 * Shows the move/resize cursor while dragging `actor` (`mode` is 'move' or
 * 'resize'), or restores the normal cursor when `mode` is null.
 * GNOME 50 replaced global.display.set_cursor() with per-actor cursors, and
 * GNOME 48 renamed Meta.Cursor.MOVE_OR_RESIZE_WINDOW to Meta.Cursor.MOVE.
 */
function setDragCursor(actor, mode) {
    if (actor.set_cursor_type) {
        actor.set_cursor_type(mode === 'move' ? Clutter.CursorType.MOVE
            : mode === 'resize' ? Clutter.CursorType.SE_RESIZE
                : Clutter.CursorType.INHERIT);
    } else {
        global.display.set_cursor(mode === 'move'
            ? Meta.Cursor.MOVE ?? Meta.Cursor.MOVE_OR_RESIZE_WINDOW
            : mode === 'resize' ? Meta.Cursor.SE_RESIZE
                : Meta.Cursor.DEFAULT);
    }
}

/**
 * One sticky note: a header (buttons + drag area), optional color, deadline
 * and delete-confirmation rows, a scrollable multi-line text entry and a
 * footer with the deadline (if any) and a resize grip.
 */
export class Note {
    constructor(manager, data) {
        this._manager = manager;
        this.id = data.id;
        this._colorId = getColor(data.color).id;
        this._fontSize = Math.clamp(data.fontSize ?? 12, MIN_FONT_SIZE, MAX_FONT_SIZE);
        this._deadline = data.deadline ?? null; // Unix timestamp (seconds) or null
        this.deadlineNotified = data.deadlineNotified ?? false;
        this._grab = null;
        this._grabHandle = null;
        this._op = null;

        this.actor = new St.BoxLayout({
            style_class: 'sticky-note',
            ...VERTICAL,
            reactive: true,
            x: data.x,
            y: data.y,
            width: Math.max(data.width, MIN_WIDTH),
            height: Math.max(data.height, MIN_HEIGHT),
        });
        this.actor._stickyNote = this;

        // Raise the note whenever it is clicked anywhere.
        this.actor.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS)
                this._manager.raise(this);
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildHeader();
        this._buildColorRow();
        this._buildDeadlineRow();
        this._buildConfirmRow();
        this._buildBody(data.text ?? '');
        this._buildFooter();

        this._applyColor();
        this._applyFontSize();
        this.updateDeadline();
    }

    // ---- UI construction -------------------------------------------------

    _makeButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'sticky-note-button',
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        button.connect('clicked', callback);
        return button;
    }

    _buildHeader() {
        this._header = new St.BoxLayout({
            style_class: 'sticky-note-header',
            reactive: true,
        });
        this.actor.add_child(this._header);

        this._header.add_child(this._makeButton('list-add-symbolic', _('New note'),
            () => this._manager.createNote({near: this})));
        this._header.add_child(this._makeButton('color-select-symbolic', _('Color'),
            () => this._toggleRow(this._colorRow)));
        this._header.add_child(this._makeButton('zoom-out-symbolic', _('Smaller text'),
            () => this._changeFontSize(-1)));
        this._header.add_child(this._makeButton('zoom-in-symbolic', _('Larger text'),
            () => this._changeFontSize(1)));
        this._header.add_child(this._makeButton('alarm-symbolic', _('Deadline'),
            () => this._toggleDeadlineRow()));

        // Empty space in the header is the drag handle.
        this._header.add_child(new St.Widget({x_expand: true}));

        this._header.add_child(this._makeButton('user-trash-symbolic', _('Delete note'),
            () => this._requestDelete()));

        this._connectGrab(this._header, 'move');
    }

    _buildColorRow() {
        this._colorRow = new St.BoxLayout({
            style_class: 'sticky-note-row sticky-note-color-row',
            visible: false,
        });
        for (const color of COLORS) {
            const swatch = new St.Button({
                style_class: 'sticky-note-swatch',
                can_focus: true,
                accessible_name: _(color.name),
                style: `background-color: ${color.bg};`,
            });
            swatch.connect('clicked', () => {
                this._colorId = color.id;
                this._applyColor();
                this._colorRow.hide();
                this._manager.scheduleSave();
            });
            this._colorRow.add_child(swatch);
        }
        this.actor.add_child(this._colorRow);
    }

    _buildDeadlineRow() {
        this._deadlineRow = new St.BoxLayout({
            style_class: 'sticky-note-row sticky-note-deadline-row',
            ...VERTICAL,
            visible: false,
        });

        this._deadlineEntry = new St.Entry({
            style_class: 'sticky-note-deadline-entry',
            can_focus: true,
            hint_text: _('YYYY-MM-DD HH:MM'),
            x_expand: true,
        });
        const clutterText = this._deadlineEntry.clutter_text;
        clutterText.connect('activate', () => this._commitDeadline());
        clutterText.connect('text-changed', () =>
            this._deadlineEntry.remove_style_class_name('error'));
        clutterText.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._deadlineRow.hide();
                this.focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._deadlineRow.add_child(this._deadlineEntry);

        const buttons = new St.BoxLayout({style_class: 'sticky-note-deadline-buttons'});
        this._removeDeadlineButton = new St.Button({
            style_class: 'sticky-note-text-button',
            label: _('Remove'),
            can_focus: true,
        });
        this._removeDeadlineButton.connect('clicked', () => {
            this._setDeadline(null);
            this._deadlineRow.hide();
        });
        buttons.add_child(this._removeDeadlineButton);
        buttons.add_child(new St.Widget({x_expand: true}));

        const setButton = new St.Button({
            style_class: 'sticky-note-text-button',
            label: _('Set'),
            can_focus: true,
        });
        setButton.connect('clicked', () => this._commitDeadline());
        buttons.add_child(setButton);
        this._deadlineRow.add_child(buttons);

        this.actor.add_child(this._deadlineRow);
    }

    _buildConfirmRow() {
        this._confirmRow = new St.BoxLayout({
            style_class: 'sticky-note-row sticky-note-confirm-row',
            visible: false,
        });
        this._confirmRow.add_child(new St.Label({
            text: _('Delete?'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const cancel = new St.Button({
            style_class: 'sticky-note-text-button',
            label: _('Cancel'),
            can_focus: true,
        });
        cancel.connect('clicked', () => this._confirmRow.hide());
        const confirm = new St.Button({
            style_class: 'sticky-note-text-button destructive',
            label: _('Delete'),
            can_focus: true,
        });
        confirm.connect('clicked', () => this._manager.deleteNote(this));
        this._confirmRow.add_child(cancel);
        this._confirmRow.add_child(confirm);
        this.actor.add_child(this._confirmRow);
    }

    _buildBody(text) {
        this._entry = new St.Entry({
            style_class: 'sticky-note-entry',
            can_focus: true,
            hint_text: _('Type here…'),
            text,
            x_expand: true,
        });

        const clutterText = this._entry.clutter_text;
        clutterText.set_single_line_mode(false);
        clutterText.set_activatable(false); // so Enter inserts a newline
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);

        clutterText.connect('text-changed', () => this._manager.scheduleSave());
        clutterText.connect('cursor-changed', () => this._ensureCursorVisible());
        clutterText.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                global.stage.set_key_focus(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Right-click menu with Copy / Paste.
        ShellEntry.addContextMenu(this._entry);

        // St.Entry centers its text vertically, so it isn't expanded; instead
        // clicks on the empty area below the text focus it (cursor at the end).
        const box = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        box.add_child(this._entry);
        box.connect('button-press-event', (actor, event) => {
            if (global.stage.get_event_actor(event) !== box || event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._entry.grab_key_focus();
            clutterText.set_cursor_position(-1);
            clutterText.set_selection_bound(-1);
            return Clutter.EVENT_STOP;
        });

        this._scroll = new St.ScrollView({
            style_class: 'sticky-note-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(box);
        this.actor.add_child(this._scroll);

        // When the text grows (e.g. a newline at the bottom), keep the cursor in view.
        this._scroll.vadjustment.connect('notify::upper', () => {
            if (clutterText.has_key_focus())
                this._ensureCursorVisible();
        });
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'sticky-note-footer'});

        // Shows the deadline; click it to change the deadline.
        this._deadlineIcon = new St.Icon({icon_name: 'alarm-symbolic', icon_size: 12});
        this._deadlineLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        const badgeBox = new St.BoxLayout({style_class: 'sticky-note-deadline-badge-box'});
        badgeBox.add_child(this._deadlineIcon);
        badgeBox.add_child(this._deadlineLabel);
        this._deadlineBadge = new St.Button({
            style_class: 'sticky-note-deadline-badge',
            can_focus: true,
            child: badgeBox,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._deadlineBadge.connect('clicked', () => this._toggleDeadlineRow());
        footer.add_child(this._deadlineBadge);

        footer.add_child(new St.Widget({x_expand: true}));

        const iconFile = Gio.File.new_for_path(
            `${this._manager.extensionPath}/icons/resize-grip-symbolic.svg`);
        this._grip = new St.Icon({
            style_class: 'sticky-note-grip',
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 14,
            reactive: true,
        });
        footer.add_child(this._grip);
        this.actor.add_child(footer);

        this._connectGrab(this._grip, 'resize');
    }

    // ---- Behavior --------------------------------------------------------

    _toggleRow(row) {
        const show = !row.visible;
        this._colorRow.hide();
        this._deadlineRow.hide();
        this._confirmRow.hide();
        row.visible = show;
    }

    _toggleDeadlineRow() {
        this._toggleRow(this._deadlineRow);
        if (!this._deadlineRow.visible)
            return;

        this._deadlineEntry.remove_style_class_name('error');
        this._deadlineEntry.set_text(formatDeadlineInput(this._deadline ?? suggestDeadline()));
        this._removeDeadlineButton.visible = this._deadline !== null;
        // Select everything so typing replaces the suggestion.
        this._deadlineEntry.grab_key_focus();
        this._deadlineEntry.clutter_text.set_selection(0, -1);
    }

    _commitDeadline() {
        const text = this._deadlineEntry.get_text();
        if (text.trim() === '') {
            this._setDeadline(null);
        } else {
            const deadline = parseDeadline(text);
            if (deadline === null) {
                this._deadlineEntry.add_style_class_name('error');
                return;
            }
            this._setDeadline(deadline);
        }
        this._deadlineRow.hide();
        this.focus();
    }

    _setDeadline(deadline) {
        this._deadline = deadline;
        this.deadlineNotified = false;
        this.updateDeadline();
        this._manager.scheduleSave();
        this._manager.deadlinesChanged();
    }

    get deadline() {
        return this._deadline;
    }

    /** The first line of the note, for notifications. */
    get title() {
        const line = this._entry.get_text().trim().split('\n')[0].trim();
        return line.length > 80 ? `${line.slice(0, 79)}…` : line;
    }

    isOverdue(now = GLib.DateTime.new_now_local()) {
        return this._deadline !== null && this._deadline <= now.to_unix();
    }

    /** Refreshes the deadline label ("Today, 17:00"…) and its due-soon / overdue style. */
    updateDeadline(now = GLib.DateTime.new_now_local()) {
        const badge = this._deadlineBadge;
        badge.visible = this._deadline !== null;
        if (!badge.visible)
            return;

        const remaining = this._deadline - now.to_unix();
        const when = formatDeadline(this._deadline, _, now);
        this._deadlineLabel.text = remaining <= 0 ? _('Overdue · %s').format(when) : when;
        badge.accessible_name = _('Deadline: %s').format(this._deadlineLabel.text);

        if (remaining <= 0) {
            badge.add_style_class_name('overdue');
            badge.remove_style_class_name('due-soon');
        } else if (remaining <= DUE_SOON_SECONDS) {
            badge.add_style_class_name('due-soon');
            badge.remove_style_class_name('overdue');
        } else {
            badge.remove_style_class_name('overdue');
            badge.remove_style_class_name('due-soon');
        }
    }

    _requestDelete() {
        if (this._entry.get_text().trim() === '')
            this._manager.deleteNote(this);
        else
            this._toggleRow(this._confirmRow);
    }

    _changeFontSize(delta) {
        this._fontSize = Math.clamp(this._fontSize + delta, MIN_FONT_SIZE, MAX_FONT_SIZE);
        this._applyFontSize();
        this._manager.scheduleSave();
    }

    _applyColor() {
        const color = getColor(this._colorId);
        this.actor.set_style(`background-color: ${color.bg};`);
        if (color.dark)
            this.actor.add_style_class_name('dark');
        else
            this.actor.remove_style_class_name('dark');
    }

    _applyFontSize() {
        this._entry.set_style(`font-size: ${this._fontSize}pt;`);
    }

    _ensureCursorVisible() {
        const adjustment = this._scroll.vadjustment;
        const clutterText = this._entry.clutter_text;
        const rect = clutterText.get_cursor_rect();
        const top = rect.origin.y + clutterText.y + this._entry.y;
        const bottom = top + rect.size.height;

        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    focus() {
        this._entry.grab_key_focus();
    }

    hasKeyFocus() {
        const focus = global.stage.key_focus;
        return focus !== null && this.actor.contains(focus);
    }

    // ---- Drag to move / resize -------------------------------------------

    _connectGrab(handle, mode) {
        handle.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._grab)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            this._op = {
                mode,
                x,
                y,
                startX: this.actor.x,
                startY: this.actor.y,
                startW: this.actor.width,
                startH: this.actor.height,
            };
            this._grab = global.stage.grab(handle);
            this._grabHandle = handle;
            setDragCursor(handle, mode);
            return Clutter.EVENT_STOP;
        });

        handle.connect('motion-event', (actor, event) => {
            if (!this._op || this._op.mode !== mode)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const dx = x - this._op.x;
            const dy = y - this._op.y;

            if (mode === 'move') {
                const [nx, ny] = this._manager.clampPosition(
                    this._op.startX + dx, this._op.startY + dy, this.actor.width);
                this.actor.set_position(nx, ny);
            } else {
                this.actor.set_size(
                    Math.max(MIN_WIDTH, this._op.startW + dx),
                    Math.max(MIN_HEIGHT, this._op.startH + dy));
            }
            return Clutter.EVENT_STOP;
        });

        handle.connect('button-release-event', (actor, event) => {
            if (!this._op || this._op.mode !== mode ||
                event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._endGrab();
            this._manager.scheduleSave();
            return Clutter.EVENT_STOP;
        });
    }

    _endGrab() {
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
            setDragCursor(this._grabHandle, null);
            this._grabHandle = null;
        }
        this._op = null;
    }

    // ---- Persistence -----------------------------------------------------

    serialize() {
        return {
            id: this.id,
            x: Math.round(this.actor.x),
            y: Math.round(this.actor.y),
            width: Math.round(this.actor.width),
            height: Math.round(this.actor.height),
            color: this._colorId,
            fontSize: this._fontSize,
            text: this._entry.get_text(),
            deadline: this._deadline,
            deadlineNotified: this.deadlineNotified,
        };
    }

    destroy() {
        this._endGrab();
        this.actor._stickyNote = null;
        this.actor.destroy();
    }
}
