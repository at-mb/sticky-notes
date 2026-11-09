# Sticky Notes — GNOME Shell 46 extension

Sticky notes that live above your windows or on the desktop.

> **Compatibility:** only **GNOME 46** is supported for now. Versions for
> newer GNOME releases are coming soon. Check your version with
> `gnome-shell --version`.

- **Create** notes with <kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> (configurable),
  from the top-bar icon, the `+` button on any note, or by showing notes when
  none exist.
- **Move** a note by dragging the empty part of its header; **resize** with
  the grip in the bottom-right corner. Clicking a note brings it to the front.
- **Color**: the eyedropper button shows 8 colors (including a dark one).
- **Text size**: the `−` / `+` buttons (6–48 pt).
- **Deadline**: the alarm button sets a due date, e.g. `2026-11-20 17:30`,
  `2026-11-20` (end of that day) or `17:30` (today). It shows at the bottom of
  the note, in bold when due within 24 hours and in red once overdue, and you
  get a notification when it is reached. Click it to change or remove it.
- **Delete**: the trash button (asks first unless the note is empty).
- **Show / hide** all notes: top-bar menu, or a keyboard shortcut you can set in
  Preferences (none by default). <kbd>Esc</kbd> while typing gives focus back to your windows.
- **Position**: “Keep Above Windows” in the top-bar menu switches between
  floating above windows and sitting on the desktop behind them.
- Notes hide automatically in the Overview and over fullscreen apps (when above windows).
- Right-click inside a note for Copy / Paste.

Notes are saved automatically to `~/.local/share/sticky-notes/notes.json`.
Back that file up to back up your notes.

## Install

```sh
make install          # packs and installs for the current user
```

On **Wayland**, GNOME only picks up newly installed extensions after you
**log out and back in**. Then:

```sh
make enable           # or use the Extensions app
```

After editing the code, run `make install` again and log out/in to reload it.

## Develop / test without logging out

```sh
make nested           # opens a nested GNOME Shell in a window
make logs             # follow GNOME Shell's log for errors
```

## Files

| File | Purpose |
| --- | --- |
| `extension.js` | Entry point: top-bar menu and keyboard shortcuts |
| `noteManager.js` | Loads/saves notes, layers, visibility, deadline notifications |
| `note.js` | A single note widget (drag, resize, colors, deadline, text) |
| `prefs.js` | Preferences window |
| `util.js` | Colors, deadline parsing/formatting and storage paths shared by the above |
| `schemas/` | GSettings schema |
