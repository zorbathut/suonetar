// The text of the desktop entry (freedesktop.org Desktop Entry Specification) that starts this checkout. Its StartupWMClass matches the window's app ID, `suonetar` from package.json's `desktopName`, which with the entry installed as suonetar.desktop ties the running window to the launcher's icon and name.

// Characters the spec reserves in an Exec argument; an argument containing any of them must be quoted.
const EXEC_RESERVED = /[\s"'\\><~|&;$*?#()`]/;

// One Exec argument. Inside quotes, `"`, `` ` ``, `$` and `\` take a backslash; the string-value escaping then doubles every backslash; and `%` is doubled throughout, since Exec gives it meaning. A control character cannot be written in a desktop entry at all.
export function execArgument(arg: string): string {
	if (/\p{Cc}/u.test(arg)) {
		throw new Error(`a desktop entry cannot hold ${JSON.stringify(arg)}`);
	}
	const quoted = arg === "" || EXEC_RESERVED.test(arg) ? `"${arg.replace(/["`$\\]/g, (c) => `\\${c}`)}"` : arg;
	return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

// Runs `npm run app` in the checkout. npm, and node for the scripts it runs, come from the desktop session's PATH.
export function desktopEntry(checkout: string): string {
	const exec = ["npm", "--prefix", checkout, "run", "app", "--"].map(execArgument).join(" ");
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Suonetar",
		"GenericName=Commit Stack Editor",
		"Comment=Edit any commit in a stack of git commits and restack the ones above it",
		// %f: a folder handed to the launcher (Open With, or a launch with a path) opens as the repository; from the menu, the window starts with none.
		`Exec=${exec} %f`,
		"Icon=suonetar",
		"Terminal=false",
		"Categories=Development;RevisionControl;",
		"StartupWMClass=suonetar",
		"",
	].join("\n");
}
