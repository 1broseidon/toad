import UIKit
import UniformTypeIdentifiers

/// The system share sheet's landing strip.
///
/// Nothing is decided here: every shared item is written into the app-group
/// inbox and the sheet is dismissed. The app drains that inbox on its next
/// resume and attaches what it finds to the conversation on screen — the
/// extension stays a mailbox, not a second client.
class ShareViewController: UIViewController {
	private let group = "group.team.toad.ios"

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .clear
		Task {
			await ingest()
			extensionContext?.completeRequest(returningItems: nil)
		}
	}

	private func ingest() async {
		guard
			let container = FileManager.default.containerURL(
				forSecurityApplicationGroupIdentifier: group)
		else { return }
		let inbox = container.appendingPathComponent("inbox", isDirectory: true)
		try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)

		var texts: [String] = []
		for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
			for provider in item.attachments ?? [] {
				// A web link or a snippet of text becomes words in the composer;
				// everything else becomes an attachment.
				if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
					let url = await loadURL(provider), !url.isFileURL {
					texts.append(url.absoluteString)
					continue
				}
				if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
					!provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
					let text = await loadText(provider) {
					texts.append(text)
					continue
				}
				if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
					await loadFile(provider, into: inbox)
				}
			}
		}
		if !texts.isEmpty {
			let notes = inbox.appendingPathComponent("notes-\(UUID().uuidString).txt")
			try? texts.joined(separator: "\n").write(to: notes, atomically: true, encoding: .utf8)
		}
	}

	private func loadURL(_ provider: NSItemProvider) async -> URL? {
		await withCheckedContinuation { done in
			provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
				done.resume(returning: item as? URL)
			}
		}
	}

	private func loadText(_ provider: NSItemProvider) async -> String? {
		await withCheckedContinuation { done in
			provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
				done.resume(returning: item as? String)
			}
		}
	}

	private func loadFile(_ provider: NSItemProvider, into inbox: URL) async {
		await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
			provider.loadFileRepresentation(forTypeIdentifier: UTType.data.identifier) { url, _ in
				defer { done.resume() }
				guard let url else { return }
				// The UUID keeps two shares of "IMG_0001.jpeg" from colliding; the
				// plugin strips it back off for the name the teammate sees.
				let dest = inbox.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
				try? FileManager.default.copyItem(at: url, to: dest)
			}
		}
	}
}
