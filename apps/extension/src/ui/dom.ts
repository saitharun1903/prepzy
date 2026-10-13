// Minimal DOM builder. Text is always set via text nodes / textContent — never innerHTML.

type Child = Node | string | number | null | undefined | false;
type Handler = (ev: Event) => void;

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  on?: Partial<Record<string, Handler>>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  name?: string;
  for?: string;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.id) el.id = props.id;
    if (props.type) el.setAttribute("type", props.type);
    if (props.name) el.setAttribute("name", props.name);
    if (props.for) el.setAttribute("for", props.for);
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (props.value !== undefined) (el as unknown as HTMLInputElement).value = props.value;
    if (props.checked !== undefined) (el as unknown as HTMLInputElement).checked = props.checked;
    if (props.disabled !== undefined) (el as unknown as HTMLButtonElement).disabled = props.disabled;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.on) for (const [ev, fn] of Object.entries(props.on)) if (fn) el.addEventListener(ev, fn);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
