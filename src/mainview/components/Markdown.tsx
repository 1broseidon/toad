import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../rpc";

/**
 * The markdown an agent is allowed to speak inside a bubble.
 *
 * A messenger has no document structure to offer, so this is deliberately not a
 * full renderer. Emphasis, code, links, lists and tables survive because a
 * person types those into a chat; headings arrive as bold text because a person
 * would not send you an `<h2>`; images and raw HTML do not survive at all.
 *
 * Everything here comes out of a language model, so the two things that matter
 * are that no HTML is ever interpreted (`react-markdown` builds React nodes and
 * never touches `innerHTML`, and `rehype-raw` is deliberately absent) and that
 * links are handed to the main process, which decides what is safe to open.
 *
 * Only an agent's bubbles come through here. What you typed is shown as you
 * typed it, so none of this has to hold up against the lighter bubble.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	/* A bubble preserves whitespace, because a message you typed should keep the
	 * shape you typed it in. Parsed markdown is the opposite: the newlines
	 * between blocks survive as text nodes, and preserving those puts a blank
	 * line between every list item. Inside here, whitespace collapses and the
	 * structure does the spacing. */
	return (
		<div className="md">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
				{text}
			</ReactMarkdown>
		</div>
	);
});

const COMPONENTS: Components = {
	/* Bubbles supply their own rhythm; a paragraph is just a line of speech.
	 * `md-flow` puts space back between them for the rare chunk that holds more
	 * than one block, like a heading glued to the list beneath it. */
	p: ({ children }) => <p className="md-p">{children}</p>,

	/* Every level lands as bold body text. Six sizes of heading in a chat
	 * bubble is a document pretending to be a message. */
	h1: Heading,
	h2: Heading,
	h3: Heading,
	h4: Heading,
	h5: Heading,
	h6: Heading,

	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	em: ({ children }) => <em className="italic">{children}</em>,
	del: ({ children }) => <del className="opacity-60">{children}</del>,

	/* Ordered lists keep the agent's own numbers, so a reply that starts at 3
	 * because it was still counting from the last bubble still reads right. */
	ul: ({ children }) => <ul className="md-list md-bullets">{children}</ul>,
	ol: ({ children, start }) => (
		<ol className="md-list md-numbers" start={start ?? undefined}>
			{children}
		</ol>
	),
	li: ({ children, className }) =>
		className?.includes("task-list-item") ? (
			<li className="md-li md-task">{children}</li>
		) : (
			<li className="md-li">{children}</li>
		),

	/* GFM checkboxes are the one input that reads as content rather than a
	 * control, so they render but never accept a click: the agent owns that
	 * list, and ticking a box here would say something that never reached it. */
	input: ({ checked, type }) =>
		type === "checkbox" ? <input type="checkbox" checked={checked} readOnly className="md-check" /> : null,

	code: ({ children, className }) =>
		/* A fence arrives with a language class and its own `pre`; a chip does
		 * not, and has to stay inline. */
		className?.startsWith("language-") ? (
			<code className={className}>{children}</code>
		) : (
			<code className="md-chip">{children}</code>
		),
	pre: ({ children }) => <pre className="md-pre">{children}</pre>,

	blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,

	table: ({ children }) => (
		<div className="md-table-scroll">
			<table className="md-table">{children}</table>
		</div>
	),
	/* GFM carries a column's alignment as a style, and a column of numbers that
	 * asked to be right-aligned is unreadable without it. This is the one place
	 * a style from the document is honoured, and the only property markdown can
	 * put here is text-align. */
	th: ({ children, style }) => (
		<th className="md-th" style={{ textAlign: style?.textAlign }}>
			{children}
		</th>
	),
	td: ({ children, style }) => (
		<td className="md-td" style={{ textAlign: style?.textAlign }}>
			{children}
		</td>
	),

	/* A rule inside a bubble has nothing to divide — the split already turned it
	 * into the gap between two bubbles. */
	hr: () => null,

	/* Remote images would let a message's author learn when it was read, and an
	 * agent that wants to show you a picture can describe it instead. */
	img: ({ alt }) => (alt ? <span className="md-alt">{alt}</span> : null),

	a: ({ children, href }) => (
		<a
			href={href}
			className="md-link"
			onClick={(event) => {
				event.preventDefault();
				if (href) api.openLink(href);
			}}
		>
			{children}
		</a>
	),
};

function Heading({ children }: { children?: ReactNode }) {
	return <p className="md-p font-semibold">{children}</p>;
}
