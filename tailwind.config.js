/** @type {import('tailwindcss').Config} */

/*
 * Every value here resolves to a named token in `tokens.css`. Nothing in this
 * file may carry a literal colour or font stack — utilities are the delivery
 * mechanism, the token block is the system.
 */
export default {
	content: ["./src/mainview/index.html", "./src/mainview/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				paper: {
					DEFAULT: "var(--color-paper)",
					2: "var(--color-paper-2)",
					3: "var(--color-paper-3)",
					4: "var(--color-paper-4)",
				},
				ink: {
					DEFAULT: "var(--color-ink)",
					2: "var(--color-ink-2)",
					3: "var(--color-ink-3)",
				},
				rule: {
					DEFAULT: "var(--color-rule)",
					2: "var(--color-rule-2)",
					strong: "var(--color-rule-strong)",
				},
				accent: {
					DEFAULT: "var(--color-accent)",
					dim: "var(--color-accent-dim)",
					deep: "var(--color-accent-deep)",
					ink: "var(--color-accent-ink)",
					wash: "var(--color-accent-wash)",
					edge: "var(--color-accent-edge)",
				},
				focus: "var(--color-focus)",
				warn: {
					DEFAULT: "var(--color-warn)",
					wash: "var(--color-warn-wash)",
					edge: "var(--color-warn-edge)",
				},
				danger: {
					DEFAULT: "var(--color-danger)",
					wash: "var(--color-danger-wash)",
					edge: "var(--color-danger-edge)",
				},
			},
			fontFamily: {
				display: "var(--font-display)",
				sans: "var(--font-body)",
				mono: "var(--font-mono)",
			},
			fontSize: {
				"2xs": ["var(--text-2xs)", { lineHeight: "1.4" }],
				xs: ["var(--text-xs)", { lineHeight: "1.45" }],
				sm: ["var(--text-sm)", { lineHeight: "1.5" }],
				md: ["var(--text-md)", { lineHeight: "var(--leading-body)" }],
				lg: ["var(--text-lg)", { lineHeight: "1.4" }],
				xl: ["var(--text-xl)", { lineHeight: "var(--leading-tight)" }],
				"2xl": ["var(--text-2xl)", { lineHeight: "var(--leading-tight)" }],
			},
			letterSpacing: {
				display: "var(--tracking-display)",
				tight: "var(--tracking-tight)",
				wide: "var(--tracking-wide)",
			},
			spacing: {
				"3xs": "var(--space-3xs)",
				"2xs": "var(--space-2xs)",
				xs: "var(--space-xs)",
				sm: "var(--space-sm)",
				md: "var(--space-md)",
				lg: "var(--space-lg)",
				xl: "var(--space-xl)",
				"2xl": "var(--space-2xl)",
				dot: "var(--dot)",
				gutter: "var(--gutter)",
				composer: "var(--composer-clear)",
				toolbar: "var(--toolbar-h)",
				lights: "var(--traffic-lights)",
			},
			maxWidth: {
				composer: "var(--composer-max)",
				settings: "var(--settings-max)",
			},
			borderRadius: {
				xs: "var(--radius-xs)",
				sm: "var(--radius-sm)",
				md: "var(--radius-md)",
				lg: "var(--radius-lg)",
				xl: "var(--radius-xl)",
				bubble: "var(--radius-bubble)",
				pill: "var(--radius-pill)",
			},
			boxShadow: {
				float: "var(--shadow-float)",
			},
			zIndex: {
				raised: "var(--z-raised)",
				sticky: "var(--z-sticky)",
				overlay: "var(--z-overlay)",
				popover: "var(--z-popover)",
			},
			transitionTimingFunction: {
				out: "var(--ease-out)",
				in: "var(--ease-in)",
				"in-out": "var(--ease-in-out)",
			},
			transitionDuration: {
				instant: "var(--dur-instant)",
				short: "var(--dur-short)",
				mid: "var(--dur-mid)",
			},
			keyframes: {
				strike: {
					"0%": { opacity: "0", transform: "translateY(3px)" },
					"100%": { opacity: "1", transform: "translateY(0)" },
				},
				throat: {
					"0%, 100%": { opacity: "1" },
					"50%": { opacity: "0.28" },
				},
				// A pane coming back over the conversation, from the edge it lives on.
				slideIn: {
					"0%": { transform: "translateX(-100%)" },
					"100%": { transform: "translateX(0)" },
				},
				slideInRight: {
					"0%": { transform: "translateX(100%)" },
					"100%": { transform: "translateX(0)" },
				},
				fadeIn: {
					"0%": { opacity: "0" },
					"100%": { opacity: "1" },
				},
			},
			animation: {
				strike: "strike var(--dur-short) var(--ease-out)",
				throat: "throat var(--dur-pulse) var(--ease-in-out) infinite",
				"slide-in": "slideIn var(--dur-mid) var(--ease-out)",
				"slide-in-right": "slideInRight var(--dur-mid) var(--ease-out)",
				"fade-in": "fadeIn var(--dur-mid) var(--ease-out)",
			},
		},
	},
	plugins: [],
};
