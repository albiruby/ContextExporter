// Word (.doc) exporter plus a small LaTeX approximator for math. A .doc file
// here is Word-flavoured HTML, which Word and Google Docs open natively. The
// approximator covers the symbols that show up most in chat math; anything
// exotic is left as-is so nothing silently disappears.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  const SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
    tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
    equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', doteq: '≐',
    infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', emptyset: '∅',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
    cup: '∪', cap: '∩', setminus: '∖',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
    leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
    sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    sqrt: '√', angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴',
    prime: '′', circ: '∘', bullet: '•', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
    langle: '⟨', rangle: '⟩', quad: '  ', qquad: '    ',
  };

  // Reads a brace group or a single token (one char or one \\command).
  function readArg(s, i) {
    while (i < s.length && s[i] === ' ') i++;
    if (s[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        if (depth > 0) j++;
      }
      return { text: s.slice(i + 1, j), next: j + 1 };
    }
    if (s[i] === '\\') {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      return { text: s.slice(i, Math.max(j, i + 2)), next: j };
    }
    return { text: s.slice(i, i + 1), next: i + 1 };
  }

  function supersub(s, i, tag, out) {
    const arg = readArg(s, i);
    out.push(`<${tag}>${renderTex(arg.text)}</${tag}>`);
    return arg.next;
  }

  function renderTex(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        let j = i + 1;
        while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
        let cmd = s.slice(i + 1, j);
        if (!cmd) {
          const next = s[i + 1] || '';
          if (next === ' ' || next === ',' || next === ';' || next === ':') out.push(' ');
          else if (next && next !== '!') out.push(CE.utils.htmlEscape(next));
          i = j + 1;
          continue;
        }
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
          const a = readArg(s, j);
          const b = readArg(s, a.next);
          out.push(`${renderTex(a.text)} / ${renderTex(b.text)}`);
          i = b.next;
        } else if (cmd === 'sqrt') {
          const a = readArg(s, j);
          out.push(`√(${renderTex(a.text)})`);
          i = a.next;
        } else if (cmd === 'text' || cmd === 'mathrm' || cmd === 'mbox') {
          const a = readArg(s, j);
          out.push(CE.utils.htmlEscape(a.text));
          i = a.next;
        } else if (cmd === 'mathbf' || cmd === 'bm' || cmd === 'boldsymbol') {
          const a = readArg(s, j);
          out.push(`<b>${renderTex(a.text)}</b>`);
          i = a.next;
        } else if (cmd === 'mathit' || cmd === 'textit') {
          const a = readArg(s, j);
          out.push(`<i>${renderTex(a.text)}</i>`);
          i = a.next;
        } else if (cmd === 'left' || cmd === 'right' || cmd === 'displaystyle'
          || cmd === 'limits' || cmd === 'nolimits' || cmd === 'big' || cmd === 'Big'
          || cmd === 'bigg' || cmd === 'Bigg' || cmd === '!' || cmd === ',' || cmd === ';'
          || cmd === ':' || cmd === ' ' || cmd === 'over' || cmd === 'overline') {
          if (cmd === 'overline' || cmd === 'over') {
            const a = readArg(s, j);
            out.push(renderTex(a.text));
            i = a.next;
          } else {
            i = j;
          }
        } else if (cmd === 'begin' || cmd === 'end') {
          const a = readArg(s, j);
          out.push(a.text === 'matrix' || a.text === 'cases' ? '' : '');
          i = a.next;
        } else {
          out.push(SYMBOLS[cmd] ?? cmd);
          i = j;
        }
        continue;
      }
      if (c === '^') { i = supersub(s, i + 1, 'sup', out); continue; }
      if (c === '_') { i = supersub(s, i + 1, 'sub', out); continue; }
      if (c === '<') { out.push('&lt;'); i++; continue; }
      if (c === '>') { out.push('&gt;'); i++; continue; }
      if (c === '&') { out.push('&amp;'); i++; continue; }
      if (c === '{' || c === '}') { i++; continue; }
      out.push(c);
      i++;
    }
    return out.join('');
  }

  function mathToHtml(tex, display) {
    let html;
    try {
      html = renderTex(String(tex || ''));
    } catch (e) {
      html = CE.utils.htmlEscape(tex);
    }
    if (!/[<>\u0370-\u03ff√∑∫≈≤≥≠±×÷→←]/.test(html)) {
      // Nothing recognised: keep the raw LaTeX visible instead of hiding it.
      return `<span class="ce-math-fallback">${CE.utils.htmlEscape(tex)}</span>`;
    }
    return display
      ? `<div class="ce-math-display">${html}</div>`
      : `<span>${html}</span>`;
  }

  CE.exporters.word = {
    ext: 'doc',
    mime: 'application/msword',
    mathToHtml,
    build(doc) {
      return CE.exporters.htmlDoc.build(doc, { word: true });
    },
  };
})();
