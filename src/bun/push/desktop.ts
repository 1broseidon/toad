import { platform } from "node:os";
import { DESKTOP_IDENTIFIER } from "../../shared/release";

/**
 * Put a toast on this machine.
 *
 * Electrobun's webviews do not share a Notification implementation — WKWebView
 * would do it, WebKitGTK would not — so this never asks the view. It talks to
 * the OS the way each desktop already expects: notify-send, Notification
 * Center via osascript, or a Windows toast. Failures are swallowed; a missing
 * notifier is a dropped toast, not a failed turn.
 */

export type DesktopPoster = (title: string, body: string) => void;

let poster: DesktopPoster = platformPoster;

export function showDesktopNotification(title: string, body: string): boolean {
	try {
		poster(title, body);
		return true;
	} catch {
		return false;
	}
}

/** Swap the poster so tests can watch the envelope without touching the OS. */
export function setDesktopPoster(next: DesktopPoster): void {
	poster = next;
}

export function resetDesktopPoster(): void {
	poster = platformPoster;
}

function platformPoster(title: string, body: string): void {
	const os = platform();
	if (os === "darwin") {
		run(["osascript", "-e", macScript(title, body)]);
		return;
	}
	if (os === "win32") {
		run(["powershell", "-NoProfile", "-STA", "-Command", windowsScript(title, body)]);
		return;
	}
	run(["notify-send", "--app-name=Toad", title, body]);
}

function run(cmd: string[]): void {
	const child = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
	child.unref();
}

/** JSON.stringify is a legal AppleScript string literal, quotes included. */
function macScript(title: string, body: string): string {
	return `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
}

function windowsScript(title: string, body: string): string {
	const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
	return [
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
		`$doc = New-Object Windows.Data.Xml.Dom.XmlDocument`,
		`$doc.LoadXml(${JSON.stringify(xml)})`,
		`$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)`,
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${JSON.stringify(DESKTOP_IDENTIFIER)}).Show($toast)`,
	].join("; ");
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
