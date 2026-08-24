import Capacitor
import Combine
import SwiftUI
import UIKit

/// The floating chrome the web layer cannot draw honestly: the action bar at
/// the foot of the Team screen and the computer pill at its head, rendered
/// with the system's own glass so the roster genuinely lenses through them.
///
/// Two hosting views, each sized to its content and pinned to an edge — no
/// passthrough tricks: touches outside their frames never reach this layer.
/// The web side drives visibility and state over `set`; taps come back as
/// `action` events. On iOS 26 the material is Liquid Glass; earlier systems
/// get `.ultraThinMaterial` with a hairline, and non-iOS shells get nothing
/// (the DOM keeps its own chrome there).

/// The app's accent, `--color-accent` (oklch 76% 0.17 142) by hand.
private enum Moss {
	static let fill = Color(red: 0.42, green: 0.80, blue: 0.38)
	static let ink = Color(red: 0.05, green: 0.09, blue: 0.06)
}

/// Plain values; the plugin reassigns the pill's rootView when they change,
/// which sidesteps ObservableObject propagation into a hosted AnyView.
struct ChromeState {
	var computer = ""
	var linked = false
	var working = false
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

private struct GlassBar: View {
	var onAction: (String) -> Void
	var body: some View {
		HStack(spacing: 6) {
			Button { onAction("computer") } label: {
				Image(systemName: "desktopcomputer")
					.font(.system(size: 17, weight: .semibold))
					.frame(width: 54, height: 46)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.foregroundStyle(.primary.opacity(0.85))

			Button { onAction("add") } label: {
				HStack(spacing: 7) {
					Image(systemName: "plus").font(.system(size: 15, weight: .bold))
					Text("Teammate").font(.system(size: 15, weight: .semibold))
				}
				.padding(.horizontal, 19)
				.frame(height: 46)
				.background(Moss.fill, in: Capsule())
				.foregroundStyle(Moss.ink)
			}
			.buttonStyle(.plain)

			Button { onAction("settings") } label: {
				Image(systemName: "gearshape")
					.font(.system(size: 17, weight: .semibold))
					.frame(width: 54, height: 46)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.foregroundStyle(.primary.opacity(0.85))
		}
		.padding(6)
		.modifier(GlassCapsule())
	}
}

private struct GlassPill: View {
	var state: ChromeState
	var onAction: (String) -> Void
	var body: some View {
		Button { onAction("pill") } label: {
			HStack(spacing: 7) {
				Circle()
					.fill(state.linked ? Moss.fill : Color.secondary)
					.frame(width: 7, height: 7)
				Text(state.computer)
					.font(.system(size: 13, weight: .semibold))
					.lineLimit(1)
				Image(systemName: "chevron.down")
					.font(.system(size: 9, weight: .bold))
					.foregroundStyle(.secondary)
			}
			.padding(.leading, 12)
			.padding(.trailing, 11)
			.frame(height: 38)
			.contentShape(Capsule())
		}
		.buttonStyle(.plain)
		.foregroundStyle(.primary.opacity(0.9))
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

	private var state = ChromeState()
	private var barHost: UIHostingController<AnyView>?
	private var pillHost: UIHostingController<AnyView>?
	/// What the web layer asked for; the keyboard subtracts from it.
	private var barWanted = false
	private var pillWanted = false
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

		let bar = UIHostingController(rootView: AnyView(GlassBar(onAction: send)))
		let pill = UIHostingController(rootView: AnyView(GlassPill(state: state, onAction: send)))
		for host in [bar, pill] {
			if #available(iOS 16.0, *) { host.sizingOptions = [.intrinsicContentSize] }
			host.view.backgroundColor = .clear
			host.view.translatesAutoresizingMaskIntoConstraints = false
			host.view.isHidden = true
			host.overrideUserInterfaceStyle = .dark
			parent.addChild(host)
			root.addSubview(host.view)
			host.didMove(toParent: parent)
		}
		NSLayoutConstraint.activate([
			bar.view.centerXAnchor.constraint(equalTo: root.centerXAnchor),
			bar.view.bottomAnchor.constraint(
				equalTo: root.safeAreaLayoutGuide.bottomAnchor, constant: -12),
			pill.view.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
			pill.view.topAnchor.constraint(
				equalTo: root.safeAreaLayoutGuide.topAnchor, constant: 8),
		])
		barHost = bar
		pillHost = pill
	}

	private func apply() {
		barHost?.view.isHidden = !barWanted || keyboardUp
		pillHost?.view.isHidden = !pillWanted || keyboardUp
		pillHost?.rootView = AnyView(GlassPill(state: state, onAction: send))
		pillHost?.view.invalidateIntrinsicContentSize()
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
		let computer = call.getString("computer")
		let linked = call.getBool("linked")
		let working = call.getBool("working")
		let bar = call.getBool("bar")
		let pill = call.getBool("pill")
		DispatchQueue.main.async {
			if let computer { self.state.computer = computer }
			if let linked { self.state.linked = linked }
			if let working { self.state.working = working }
			if let bar { self.barWanted = bar }
			if let pill { self.pillWanted = pill }
			self.apply()
		}
		call.resolve()
	}
}
