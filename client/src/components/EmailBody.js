import React, { useMemo } from "react";
import DOMPurify from "dompurify";

/**
 * EmailBody — renders customer email HTML safely.
 *
 * Inbound email is fully attacker-controlled: anyone can send our support
 * address a message containing <script>, an onerror handler, or a form that
 * posts an agent's session somewhere. We still have to render it as HTML,
 * because stripping formatting would make real customer mail unreadable.
 * So every fragment goes through DOMPurify first.
 *
 * Decisions worth knowing:
 *  - <style> is dropped. Email CSS is not scoped, so a rule like
 *    `div { position: fixed }` would escape the message bubble and repaint
 *    the whole inbox. Inline style attributes survive (DOMPurify sanitises
 *    their contents), which is what most mail relies on anyway.
 *  - Layout tables are allowed — virtually every marketing email needs them.
 *  - Links are forced to open in a new tab with rel="noopener noreferrer",
 *    so a message can never repoint the inbox tab at a phishing page.
 *  - Remote images are allowed (data: too, since the server inlines CID
 *    attachments as data URIs). The CSP restricts them to https:.
 */

const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "caption", "center", "code", "col",
  "colgroup", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "font",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p",
  "pre", "s", "small", "span", "strong", "sub", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "u", "ul", "wbr",
];

const ALLOWED_ATTR = [
  "align", "alt", "bgcolor", "border", "cellpadding", "cellspacing", "class",
  "color", "colspan", "dir", "face", "height", "href", "rowspan", "size",
  "src", "style", "title", "valign", "width",
];

let hookInstalled = false;
function installHook() {
  if (hookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  hookInstalled = true;
}

const EmailBody = ({ html, className, style }) => {
  const clean = useMemo(() => {
    if (!html) return "";
    installHook();
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // Belt and braces — these are already outside ALLOWED_TAGS
      FORBID_TAGS: [
        "script", "style", "iframe", "object", "embed", "form", "input",
        "button", "textarea", "select", "base", "link", "meta",
      ],
      FORBID_ATTR: ["srcset", "formaction", "ping"],
      ALLOW_DATA_ATTR: false,
      // Block javascript: / vbscript: URLs while keeping http(s), mailto,
      // tel and the data: images the server inlines from CID attachments
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|tel|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
  }, [html]);

  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
};

export default EmailBody;
