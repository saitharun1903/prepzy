"use client";

import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, type DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags as t } from "@lezer/highlight";

const style = HighlightStyle.define([
  { tag: t.keyword, color: "#1b2f52", fontWeight: "600" },     // \commands
  { tag: t.tagName, color: "#1b2f52", fontWeight: "600" },
  { tag: t.atom, color: "#8a6a1f" },                           // environment names
  { tag: t.bracket, color: "#7c5cff" },
  { tag: t.comment, color: "#8a93a3", fontStyle: "italic" },
  { tag: t.string, color: "#12925f" },
  { tag: t.number, color: "#b45309" },
  { tag: t.variableName, color: "#0e7490" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13.5px", backgroundColor: "#ffffff" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "#faf8f3", color: "#9aa3b2", border: "none", borderRight: "1px solid #ece6d8" },
  ".cm-activeLine": { backgroundColor: "#f6f3ec" },
  ".cm-activeLineGutter": { backgroundColor: "#efe9dc", color: "#1b2f52" },
  ".cm-content": { padding: "10px 0" },
  "&.cm-focused": { outline: "none" },
  ".cm-error-line": { backgroundColor: "#fdecec" },
});

const setErrors = StateEffect.define<number[]>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrors)) {
        const marks = e.value
          .filter((n) => n >= 1 && n <= tr.state.doc.lines)
          .map((n) => Decoration.line({ class: "cm-error-line" }).range(tr.state.doc.line(n).from));
        deco = Decoration.set(marks, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export type LatexEditorHandle = { goToLine: (n: number) => void };

export function LatexEditor({ value, onChange, onCompile, errorLines, handleRef }: {
  value: string;
  onChange: (v: string) => void;
  onCompile: () => void;
  errorLines: number[];
  handleRef?: React.MutableRefObject<LatexEditorHandle | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onCompile });
  cb.current = { onChange, onCompile };
  const wrap = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), bracketMatching(),
          StreamLanguage.define(stex), syntaxHighlighting(style), theme, errorField,
          wrap.current.of(EditorView.lineWrapping),
          keymap.of([
            { key: "Mod-Enter", run: () => { cb.current.onCompile(); return true; } },
            { key: "Mod-s", run: () => { cb.current.onCompile(); return true; }, preventDefault: true },
            indentWithTab, ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
          EditorView.contentAttributes.of({ "aria-label": "LaTeX source", spellcheck: "false" }),
        ],
      }),
    });
    view.current = v;
    if (handleRef) {
      handleRef.current = {
        goToLine: (n: number) => {
          const line = v.state.doc.line(Math.max(1, Math.min(n, v.state.doc.lines)));
          v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
          v.focus();
        },
      };
    }
    return () => { v.destroy(); view.current = null; };
    // Created once; external value changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrors.of(errorLines) });
  }, [errorLines]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
