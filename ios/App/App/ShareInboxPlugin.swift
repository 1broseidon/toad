import Capacitor
import Foundation
import UniformTypeIdentifiers

/// The app-group inbox the share extension fills, drained into the webview.
///
/// Files come back as base64 because that is the shape attachments already
/// travel in — the web layer hands them straight to `saveAttachment` on the
/// desktop's wire. Texts are lines for the composer. Draining empties the
/// inbox: a share is delivered once or not at all.
@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "ShareInboxPlugin"
	public let jsName = "ShareInbox"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "drain", returnType: CAPPluginReturnPromise)
	]

	private let group = "group.team.toad.ios"
	/// A UUID, a dash: what the extension prepends to keep names unique.
	private let uuidPrefix = 37

	@objc func drain(_ call: CAPPluginCall) {
		DispatchQueue.global(qos: .userInitiated).async {
			let fm = FileManager.default
			guard
				let container = fm.containerURL(forSecurityApplicationGroupIdentifier: self.group)
			else {
				call.resolve(["files": [], "texts": []])
				return
			}
			let inbox = container.appendingPathComponent("inbox", isDirectory: true)
			var files: [[String: String]] = []
			var texts: [String] = []
			let entries =
				(try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
			for url in entries {
				if url.lastPathComponent.hasPrefix("notes-") {
					if let text = try? String(contentsOf: url, encoding: .utf8) {
						texts.append(
							contentsOf: text.split(separator: "\n").map(String.init))
					}
				} else if let data = try? Data(contentsOf: url) {
					let stripped = String(url.lastPathComponent.dropFirst(self.uuidPrefix))
					let mime =
						UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
						?? "application/octet-stream"
					files.append([
						"name": stripped.isEmpty ? url.lastPathComponent : stripped,
						"mimeType": mime,
						"data": data.base64EncodedString(),
					])
				}
				try? fm.removeItem(at: url)
			}
			call.resolve(["files": files, "texts": texts])
		}
	}
}
