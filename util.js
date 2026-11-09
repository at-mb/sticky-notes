// Shared by the extension and the preferences window (GLib only, no Shell imports).
import GLib from 'gi://GLib';

export const COLORS = [
    {id: 'yellow', name: 'Yellow', bg: '#fff3a3', dark: false},
    {id: 'orange', name: 'Orange', bg: '#ffd5a8', dark: false},
    {id: 'pink', name: 'Pink', bg: '#ffc9da', dark: false},
    {id: 'purple', name: 'Purple', bg: '#ddcdff', dark: false},
    {id: 'blue', name: 'Blue', bg: '#c4e3ff', dark: false},
    {id: 'green', name: 'Green', bg: '#cdf1c4', dark: false},
    {id: 'gray', name: 'Gray', bg: '#e6e6e6', dark: false},
    {id: 'charcoal', name: 'Charcoal', bg: '#3a3a3c', dark: true},
];

export function getColor(id) {
    return COLORS.find(c => c.id === id) ?? COLORS[0];
}

export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 48;

// ---- Deadlines (stored as Unix timestamps, in seconds) ------------------

/** A deadline closer than this is shown as "due soon". */
export const DUE_SOON_SECONDS = 24 * 60 * 60;

export const DEADLINE_INPUT_FORMAT = '%Y-%m-%d %H:%M';

/**
 * Parses what the user typed as a deadline, in local time:
 *   "2026-11-20 17:30" → that moment
 *   "2026-11-20"       → the end of that day (23:59)
 *   "17:30"            → today at 17:30
 * Returns a Unix timestamp, or null if the text isn't a valid date.
 */
export function parseDeadline(text, now = GLib.DateTime.new_now_local()) {
    const s = text.trim();
    let year, month, day, hour, minute, m;

    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/))) {
        [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
        [hour, minute] = m[4] === undefined ? [23, 59] : [Number(m[4]), Number(m[5])];
    } else if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
        [year, month, day] = [now.get_year(), now.get_month(), now.get_day_of_month()];
        [hour, minute] = [Number(m[1]), Number(m[2])];
    } else {
        return null;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
        return null;
    const dt = GLib.DateTime.new_local(year, month, day, hour, minute, 0);
    // new_local() also rejects impossible dates like 2026-02-30.
    if (!dt || dt.get_day_of_month() !== day)
        return null;
    return dt.to_unix();
}

/** A suggestion to pre-fill the deadline field with: tomorrow, at the next full hour. */
export function suggestDeadline(now = GLib.DateTime.new_now_local()) {
    const nextHour = now.add_minutes(60 - now.get_minute()).add_seconds(-now.get_seconds());
    return nextHour.add_days(1).to_unix();
}

export function formatDeadlineInput(timestamp) {
    return GLib.DateTime.new_from_unix_local(timestamp).format(DEADLINE_INPUT_FORMAT);
}

export function startOfDay(dt) {
    return GLib.DateTime.new_local(dt.get_year(), dt.get_month(), dt.get_day_of_month(), 0, 0, 0);
}

/**
 * Short human-readable deadline, e.g. "Today, 17:30", "Tomorrow, 09:00",
 * "Fri 20 Nov, 17:30". `_` is the caller's gettext function.
 */
export function formatDeadline(timestamp, _, now = GLib.DateTime.new_now_local()) {
    const dt = GLib.DateTime.new_from_unix_local(timestamp);
    const time = dt.format('%H:%M');
    const days = Math.round(startOfDay(dt).difference(startOfDay(now)) / GLib.TIME_SPAN_DAY);

    if (days === 0)
        return _('Today, %s').format(time);
    if (days === 1)
        return _('Tomorrow, %s').format(time);
    if (days === -1)
        return _('Yesterday, %s').format(time);
    if (dt.get_year() === now.get_year())
        return dt.format('%a %-d %b, %H:%M');
    return dt.format('%-d %b %Y, %H:%M');
}

export function getDataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'sticky-notes']);
}

export function getNotesPath() {
    return GLib.build_filenamev([getDataDir(), 'notes.json']);
}
