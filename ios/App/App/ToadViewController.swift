import Capacitor
import UIKit

/// The app's own bridge controller — the documented home for plugins that
/// live in this project rather than in a package.
class ToadViewController: CAPBridgeViewController {
	override open func capacitorDidLoad() {
		bridge?.registerPluginInstance(ShareInboxPlugin())
		bridge?.registerPluginInstance(FloatingChromePlugin())
	}
}
