// One-off: does WKWebView answer Notification.requestPermission() and
// actually post to Notification Center, with zero native bridging? Run
// this pasted into the packaged app's devtools console (right-click →
// Inspect Element, if devtools are enabled) or via a temporary button.
// Kept as a hack script rather than product code — see docs/push.md.
if (typeof Notification === "undefined") {
	console.log("Notification is not defined in this webview");
} else {
	Notification.requestPermission().then((perm) => {
		console.log("permission:", perm);
		if (perm === "granted") {
			new Notification("Toad spike", { body: "If you see this, WKWebView needs no bridge." });
		}
	});
}
