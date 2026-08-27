import Capacitor
import SwiftUI
import UIKit

/// The floating chrome: one glass object — the labeled trio at the foot of
/// the Team screen. Desktop (with the wire's status dot), a moss disc for
/// adding a teammate, Settings. There is deliberately no second piece of
/// chrome anywhere on the screen.
///
/// One hosting view, sized to its content, pinned bottom-centre — touches
/// outside its frame never reach this layer. The web side drives visibility
/// and the wire dot over `set`; taps come back as `action` events with ids
/// `desktop` / `add` / `settings`. iOS 26 draws real Liquid Glass; earlier
/// systems get `.ultraThinMaterial` with a hairline. Non-iOS shells get
/// nothing — the DOM keeps its own chrome there.

/// The app's accent, `--color-accent` (oklch 76% 0.17 142) by hand.
private enum Moss {
	static let fill = Color(red: 0.42, green: 0.80, blue: 0.38)
	static let ink = Color(red: 0.05, green: 0.09, blue: 0.06)
}

private struct GlassCapsule: ViewModifier {
	func body(content: Content) -> some View {
		if #available(iOS 26.0, *) {
			content.glassEffect(.regular.interactive())
		} else {
			content
				.background(.ultraThinMaterial, in: Capsule())
				.overlay(Capsule().strokeBorder(.white.opacity(0.08), lineWidth: 0.5))
		}
	}
}

/// A flat item: a 22 pt glyph over an 11 pt label. The label is the fix —
/// an unlabeled monitor glyph was the confusing part of the first cut.
private struct BarItem: View {
	let icon: String
	let label: String
	/// Moss when the wire is up, hollow while looking — nil for no dot.
	var dot: Bool? = nil
	let action: () -> Void
	var body: some View {
		Button(action: action) {
			VStack(spacing: 4) {
				Image(systemName: icon)
					.font(.system(size: 19, weight: .medium))
					.frame(height: 24)
					.overlay(alignment: .topTrailing) {
						if let dot {
							Circle()
								.fill(dot ? Moss.fill : Color.clear)
								.overlay(
									Circle().strokeBorder(
										dot ? Color.clear : Color.secondary, lineWidth: 1.5)
								)
								.frame(width: 7, height: 7)
								.offset(x: 5, y: -1)
						}
					}
				Text(label)
					.font(.system(size: 11, weight: .semibold))
			}
			.frame(minWidth: 66, minHeight: 56)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.foregroundStyle(.primary.opacity(0.85))
	}
}

private struct GlassBar: View {
	var linked: Bool
	var onAction: (String) -> Void
	var body: some View {
		/// Two items, not three: the desktop is plumbing now — the room is the
		/// world and Rooms live inside Settings, which inherits the wire dot.
		HStack(spacing: 2) {
			Button { onAction("add") } label: {
				Image(systemName: "plus")
					.font(.system(size: 19, weight: .bold))
					.frame(width: 46, height: 46)
					.background(Moss.fill, in: Circle())
					.foregroundStyle(Moss.ink)
					.shadow(color: Moss.fill.opacity(0.25), radius: 7, y: 4)
			}
			.buttonStyle(.plain)
			.padding(.horizontal, 8)
			.accessibilityLabel("Add teammate")
			BarItem(icon: "gearshape", label: "Settings", dot: linked) {
				onAction("settings")
			}
		}
		.padding(.vertical, 7)
		.padding(.horizontal, 9)
		.modifier(GlassCapsule())
	}
}

@objc(FloatingChromePlugin)
public class FloatingChromePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "FloatingChromePlugin"
	public let jsName = "FloatingChrome"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
	]

	private var barHost: UIHostingController<AnyView>?
	private var linked = false
	/// What the web layer asked for; the keyboard subtracts from it.
	private var barWanted = false
	private var keyboardUp = false
	private var send: (String) -> Void = { _ in }

	override public func load() {
		DispatchQueue.main.async { self.attach() }
		NotificationCenter.default.addObserver(
			self, selector: #selector(self.keyboardShown),
			name: UIResponder.keyboardWillShowNotification, object: nil)
		NotificationCenter.default.addObserver(
			self, selector: #selector(self.keyboardHidden),
			name: UIResponder.keyboardWillHideNotification, object: nil)
	}

	private func attach() {
		guard let parent = bridge?.viewController, let root = parent.view else { return }
		let send: (String) -> Void = { [weak self] id in
			self?.notifyListeners("action", data: ["id": id])
		}
		self.send = send

		let bar = UIHostingController(rootView: AnyView(GlassBar(linked: linked, onAction: send)))
		if #available(iOS 16.0, *) { bar.sizingOptions = [.intrinsicContentSize] }
		bar.view.backgroundColor = .clear
		bar.view.translatesAutoresizingMaskIntoConstraints = false
		bar.view.isHidden = true
		bar.overrideUserInterfaceStyle = .dark
		parent.addChild(bar)
		root.addSubview(bar.view)
		bar.didMove(toParent: parent)
		NSLayoutConstraint.activate([
			bar.view.centerXAnchor.constraint(equalTo: root.centerXAnchor),
			bar.view.bottomAnchor.constraint(
				equalTo: root.safeAreaLayoutGuide.bottomAnchor, constant: -12),
		])
		barHost = bar
	}

	private func apply() {
		barHost?.view.isHidden = !barWanted || keyboardUp
		barHost?.rootView = AnyView(GlassBar(linked: linked, onAction: send))
		barHost?.view.invalidateIntrinsicContentSize()
	}

	@objc private func keyboardShown() {
		keyboardUp = true
		apply()
	}

	@objc private func keyboardHidden() {
		keyboardUp = false
		apply()
	}

	@objc func set(_ call: CAPPluginCall) {
		let linked = call.getBool("linked")
		let bar = call.getBool("bar")
		DispatchQueue.main.async {
			if let linked { self.linked = linked }
			if let bar { self.barWanted = bar }
			self.apply()
		}
		call.resolve()
	}
}
