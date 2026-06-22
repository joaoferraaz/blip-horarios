// ==UserScript==
// @name         Blip - Preencher Horários de Atendimento (via Google Sheets)
// @namespace    https://github.com/joaoferraaz/blip-horarios
// @version      1.0.0
// @description  Lê uma planilha do Google Sheets (Fila / Horario / Atendentes) e preenche automaticamente os campos da tela "Horários de atendimento" do Blip.
// @author       João Victor Ferraz
// @match        https://*.blip.ai/*
// @match        https://*.msging.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      docs.google.com
// @connect      googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
  COMO USAR
  1. Compartilhe a planilha do Google Sheets como "Qualquer pessoa com o link -> Leitor".
  2. Abra a tela "Horários de atendimento" do Blip.
  3. Clique no botão flutuante "Blip Horários" (canto inferior direito).
  4. Cole a URL da planilha e clique "Carregar planilha".
  5. "Criar TODAS as filas" cria tudo automaticamente; "Preencher 1 fila" só preenche o form aberto.

  Planilha: cabeçalho com as colunas Fila | Horario | Atendentes
  (Fila e Horario só na primeira linha de cada grupo; e-mails dos atendentes um por linha abaixo).
*/

(function () {
  'use strict';

  // 1) PARSER DO TEXTO DE HORÁRIO -> faixas por dia da semana
  // Ordem usada pelo Blip: Segunda(0) ... Domingo(6)
  const DIAS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'];
  const DIAS_LABEL = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

  function normalizar(txt) {
    return (txt || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/-feira/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function indiceDia(nome) {
    const n = normalizar(nome);
    return DIAS.findIndex((d) => d === n || d.startsWith(n) || n.startsWith(d));
  }

  // Converte "Segunda a Sexta das 09:00 às 17:00 e Sábado de 08:30 às 11:30"
  // num array de 7 posições [Seg..Dom], cada uma { de, ate } ou null.
  function parseHorario(texto) {
    const dias = [null, null, null, null, null, null, null];
    if (!texto) return dias;

    // trechos separados por vírgula OU por " e "
    const trechos = texto.split(/\s*,\s*|\s+e\s+/i);
    const reTrecho = /(.+?)\s+(?:das|de|d[ao]s)\s+(\d{1,2}:\d{2})\s+(?:a|à|as|às)\s+(\d{1,2}:\d{2})/i;

    for (const trecho of trechos) {
      const m = trecho.match(reTrecho);
      if (!m) continue;
      const diaSpec = m[1].trim();
      const de = m[2].padStart(5, '0');
      const ate = m[3].padStart(5, '0');

      const intervalo = diaSpec.split(/\s+a\s+/i); // "Segunda a Sexta" vs dia único
      if (intervalo.length === 2) {
        const ini = indiceDia(intervalo[0]);
        const fim = indiceDia(intervalo[1]);
        if (ini >= 0 && fim >= 0) {
          for (let i = ini; i <= fim; i++) dias[i] = { de, ate };
        }
      } else {
        const i = indiceDia(diaSpec);
        if (i >= 0) dias[i] = { de, ate };
      }
    }
    return dias;
  }

  // 2) LEITURA DA PLANILHA (Google Sheets via endpoint gviz CSV)
  function urlParaCsv(url) {
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const id = idMatch[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`;
  }

  function baixarCsv(csvUrl) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: csvUrl,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('Falha de rede ao baixar a planilha')),
      });
    });
  }

  // Parser de CSV que respeita aspas e quebras de linha dentro de campos
  function parseCsv(texto) {
    const linhas = [];
    let campo = '';
    let linha = [];
    let aspas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (aspas) {
        if (c === '"') {
          if (texto[i + 1] === '"') {
            campo += '"';
            i++;
          } else aspas = false;
        } else campo += c;
      } else {
        if (c === '"') aspas = true;
        else if (c === ',') {
          linha.push(campo);
          campo = '';
        } else if (c === '\n') {
          linha.push(campo);
          linhas.push(linha);
          linha = [];
          campo = '';
        } else if (c === '\r') {
        } else campo += c;
      }
    }
    if (campo.length || linha.length) {
      linha.push(campo);
      linhas.push(linha);
    }
    return linhas;
  }

  function acharColuna(header, nomes) {
    return header.findIndex((h) => nomes.includes(normalizar(h)));
  }

  // Agrupa as linhas em { fila, horario, atendentes:[] }. Um grupo começa quando a
  // coluna "Fila" tem valor; as linhas seguintes (Fila vazia) somam atendentes ao grupo atual.
  function montarGrupos(linhas) {
    if (!linhas.length) return [];
    const header = linhas[0];
    const cFila = acharColuna(header, ['fila', 'filas']);
    const cHorario = acharColuna(header, ['horario', 'horarios']);
    const cAtend = acharColuna(header, ['atendentes', 'atendente', 'emails', 'email']);

    if (cFila < 0 || cHorario < 0 || cAtend < 0) {
      throw new Error(
        'Cabeçalho não encontrado. A planilha precisa ter as colunas Fila, Horario e Atendentes. Encontrei: ' +
          header.join(' | ')
      );
    }

    const grupos = [];
    let atual = null;
    for (let i = 1; i < linhas.length; i++) {
      const row = linhas[i];
      const fila = (row[cFila] || '').trim();
      const atend = (row[cAtend] || '').trim().replace(/,\s*$/, '');

      if (fila) {
        atual = { fila, horario: (row[cHorario] || '').trim(), atendentes: [] };
        grupos.push(atual);
      }
      if (atual && atend) {
        atend
          .split(/[,;\n]/)
          .map((e) => e.trim())
          .filter(Boolean)
          .forEach((e) => atual.atendentes.push(e));
      }
    }
    return grupos;
  }

  // 3) PREENCHIMENTO DOS CAMPOS DO BLIP

  // Define valor em inputs controlados por React.
  function setReactValue(el, value) {
    // respeita o maxlength do campo (senão o Blip rejeita ao salvar)
    let max = el.maxLength;
    if (!max || max < 0) {
      const root = el.getRootNode && el.getRootNode();
      const host = root && root.host; // componente bds-input que envolve o input
      if (host) {
        const m = parseInt(host.getAttribute('maxlength') || host.getAttribute('max-length') || '', 10);
        if (m > 0) max = m;
      }
    }
    if (max && max > 0 && value.length > max) value = value.slice(0, max);

    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function textosIguais(a, b) {
    return normalizar(a) === normalizar(b);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Busca que ATRAVESSA Shadow DOM (os componentes bds-* escondem o <input> real no shadowRoot).
  function deepQueryAll(selector, root) {
    root = root || document;
    const res = [];
    const visitar = (node) => {
      let achados = [];
      try {
        achados = node.querySelectorAll(selector);
      } catch (e) {
        achados = [];
      }
      achados.forEach((el) => res.push(el));
      node.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) visitar(el.shadowRoot);
      });
    };
    visitar(root);
    return res;
  }

  // Elemento MAIS INTERNO cujo texto é exatamente igual ao procurado
  function acharElementoMaisInterno(texto) {
    const els = [...document.querySelectorAll('*')];
    for (const e of els) {
      if (!textosIguais((e.textContent || '').trim(), texto)) continue;
      const filhoIgual = [...e.children].some((c) => textosIguais((c.textContent || '').trim(), texto));
      if (!filhoIgual) return e;
    }
    return null;
  }

  function acharBotaoMais(scope) {
    const ic = [...scope.querySelectorAll('bds-icon')].find((i) => {
      const n = normalizar(i.getAttribute('name') || '');
      return n === 'plus' || n === 'add' || n === 'more' || n.includes('plus') || n.includes('add');
    });
    if (ic) return ic;
    return [...scope.querySelectorAll('button,[role="button"]')].find((b) => (b.textContent || '').trim() === '+') || null;
  }

  function acharSecaoPorTitulo(titulo) {
    return acharElementoMaisInterno(titulo);
  }

  function acharInputPorPlaceholder(trecho) {
    const t = normalizar(trecho);
    return deepQueryAll('input, textarea').find((e) => normalizar(e.getAttribute('placeholder') || '').includes(t)) || null;
  }

  function pressEnter(el) {
    el.focus();
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    });
  }

  function realClick(el) {
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (e) {}
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      try {
        const Ev = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
    });
    if (typeof el.click === 'function') {
      try {
        el.click();
      } catch (e) {}
    }
  }

  // Elemento mais interno cujo texto CONTÉM o trecho
  function acharPorTextoContendo(trecho, maxLen) {
    const alvo = normalizar(trecho);
    for (const e of [...document.querySelectorAll('*')]) {
      const t = normalizar((e.textContent || '').trim());
      if (!t.includes(alvo)) continue;
      if (maxLen && t.length > maxLen) continue;
      const filhoContem = [...e.children].some((c) => {
        const tc = normalizar((c.textContent || '').trim());
        return tc.includes(alvo) && (!maxLen || tc.length <= maxLen);
      });
      if (!filhoContem) return e;
    }
    return null;
  }

  function opcoesDropdownVisiveis() {
    return deepQueryAll('bds-select-option').filter(
      (o) => (o.textContent || '').trim().length > 0 && o.offsetParent !== null
    );
  }

  // Acha a opção de fila pelo texto; se só sobrou 1 opção visível (lista já filtrada), usa ela
  function acharOpcaoDropdown(texto) {
    const opts = opcoesDropdownVisiveis();
    const alvo = normalizar(texto);
    return (
      opts.find((o) => normalizar((o.textContent || '').trim()) === alvo) ||
      opts.find((o) => normalizar((o.textContent || '').trim()).includes(alvo)) ||
      (opts.length === 1 ? opts[0] : null)
    );
  }

  // O clicável da bds-select-option fica no Shadow DOM (.select-option / [data-event="click"])
  function clicarOpcao(opcao) {
    const sr = opcao.shadowRoot;
    const interno = sr && (sr.querySelector('[data-event="click"]') || sr.querySelector('.select-option'));
    realClick(interno || opcao);
  }

  // Estado de um bds-switch (o atributo é checked="true"/"false", não a presença do atributo)
  function switchLigado(sw) {
    if ((sw.getAttribute('checked') || '').toLowerCase() === 'true') return true;
    const sr = sw.shadowRoot;
    if (sr) {
      const inp = sr.querySelector('input[type="checkbox"]');
      if (inp && inp.checked) return true;
      const slider = sr.querySelector('.slider');
      if (slider && /--selected/.test(slider.className) && !/--deselected/.test(slider.className)) return true;
    }
    return false;
  }

  function clicarSwitch(sw) {
    const sr = sw.shadowRoot;
    const interno = sr && (sr.querySelector('label') || sr.querySelector('.slider') || sr.querySelector('input'));
    realClick(interno || sw);
  }

  // Garante que o toggle "Inserção em massa" esteja LIGADO
  function garantirInsercaoEmMassa(rel) {
    const labelEl = acharPorTextoContendo('inserção em massa', 40);
    if (!labelEl) {
      rel.push('ℹ️ Toggle "Inserção em massa" não encontrado (ative manualmente).');
      return;
    }
    let node = labelEl;
    let sw = null;
    for (let i = 0; i < 6 && node; i++) {
      const cand = deepQueryAll('bds-switch', node);
      if (cand.length) {
        sw = cand[0];
        break;
      }
      node = node.parentElement;
    }
    if (!sw) {
      realClick(labelEl);
      rel.push('⚠️ Switch da massa não localizado; cliquei no rótulo — confira.');
      return;
    }
    if (switchLigado(sw)) {
      rel.push('ℹ️ "Inserção em massa" já estava ativa');
      return;
    }
    clicarSwitch(sw);
    rel.push('✅ "Inserção em massa" ativada');
  }

  // Linha da Programação de um dia: sobe do rótulo até um container com input[type=time] ou o "+"
  function acharLinhaDoDia(label) {
    const diaEl = acharElementoMaisInterno(label);
    if (!diaEl) return null;
    let node = diaEl;
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const temTime = deepQueryAll('input[type="time"]', node).length >= 1;
      if (temTime || !!acharBotaoMais(node)) return node;
    }
    return null;
  }

  function inputsDeHorario(linha) {
    return deepQueryAll('input[type="time"]', linha);
  }

  async function preencherProgramacao(dias, rel) {
    let ok = 0;
    for (let i = 0; i < 7; i++) {
      const faixa = dias[i];
      if (!faixa) continue; // dia sem atendimento -> não mexe
      const linha = acharLinhaDoDia(DIAS_LABEL[i]);
      if (!linha) {
        rel.push(`⚠️ Não achei a linha do dia "${DIAS_LABEL[i]}"`);
        continue;
      }
      let times = inputsDeHorario(linha);
      // Dia ainda "Sem atendentes disponíveis": clica no "+" para criar o slot
      if (times.length < 2) {
        const mais = acharBotaoMais(linha);
        if (mais) {
          mais.click();
          await sleep(300);
          times = inputsDeHorario(linha);
        }
      }
      if (times.length >= 2) {
        const de = times.find((t) => (t.name || '') === 'startTime') || times[0];
        const ate = times.find((t) => (t.name || '') === 'endTime') || times[1];
        setReactValue(de, faixa.de);
        setReactValue(ate, faixa.ate);
        ok++;
      } else {
        rel.push(`⚠️ "${DIAS_LABEL[i]}" sem campos de horário (encontrei ${times.length}).`);
      }
    }
    return ok;
  }

  async function preencherCampos(grupo, rel) {
    const dias = parseHorario(grupo.horario);
    const nome = `${grupo.fila}|${grupo.horario}`;

    // --- Nome e descrição ---
    const secaoNome = acharSecaoPorTitulo('Nome e descrição');
    let inputsNome = [];
    if (secaoNome) {
      let node = secaoNome;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement;
        if (node && deepQueryAll('input, textarea', node).length >= 2) {
          inputsNome = deepQueryAll('input, textarea', node);
          break;
        }
      }
    }
    if (inputsNome.length >= 2) {
      setReactValue(inputsNome[0], nome);
      setReactValue(inputsNome[1], grupo.horario);
      rel.push('✅ Nome e descrição preenchidos');
    } else {
      rel.push('⚠️ Não localizei os campos de Nome/Descrição');
    }

    // --- Atendentes (inserção em massa) ---
    garantirInsercaoEmMassa(rel);
    await sleep(300);
    const inputAtend =
      acharInputPorPlaceholder('e-mails dos atendentes') ||
      acharInputPorPlaceholder('separados por vírgula') ||
      acharInputPorPlaceholder('atendentes');
    let atendentesOk = false;
    if (!inputAtend) {
      rel.push('⚠️ Não localizei o campo de Atendentes');
    } else if (grupo.atendentes.length === 0) {
      rel.push('⚠️ A planilha não tem atendentes para esta fila');
    } else {
      setReactValue(inputAtend, grupo.atendentes.join(', '));
      await sleep(150);
      pressEnter(inputAtend);
      rel.push(`✅ Atendentes preenchidos (${grupo.atendentes.length} e-mails)`);
      atendentesOk = true;
    }

    // --- Filas ---
    const inputFila = acharInputPorPlaceholder('filas de atendimento') || acharInputPorPlaceholder('selecione as filas');
    if (inputFila) {
      realClick(inputFila);
      await sleep(200);
      setReactValue(inputFila, grupo.fila); // filtra a lista
      await sleep(600);
      const opcao = acharOpcaoDropdown(grupo.fila);
      if (opcao) {
        clicarOpcao(opcao);
        rel.push(`✅ Fila selecionada: "${(opcao.textContent || '').trim()}"`);
      } else {
        rel.push(`⚠️ Não achei a opção "${grupo.fila}" no dropdown (${opcoesDropdownVisiveis().length} visíveis) — selecione manualmente.`);
      }
    } else {
      rel.push('⚠️ Não localizei o campo de Filas (selecione manualmente)');
    }

    // --- Programação ---
    const n = await preencherProgramacao(dias, rel);
    rel.push(`✅ Programação: ${n} dia(s) preenchido(s)`);

    const resumo = dias.map((d, i) => (d ? `${DIAS_LABEL[i]} ${d.de}-${d.ate}` : `${DIAS_LABEL[i]} —`)).join(' | ');
    rel.push('🕒 ' + resumo);

    return { atendentesOk: atendentesOk };
  }

  // 4) INSPETOR (dump da estrutura, para ajustar seletores)
  function inspecionar() {
    const out = [];
    out.push('URL: ' + location.href);
    out.push('--- inputs/textarea (incl. Shadow DOM) ---');
    deepQueryAll('input, textarea').forEach((el, i) => {
      out.push(
        `#${i} <${el.tagName.toLowerCase()}> type=${el.type || ''} name=${el.name || ''} ` +
          `placeholder="${el.getAttribute('placeholder') || ''}" ` +
          `value="${(el.value || '').slice(0, 40)}"`
      );
    });
    out.push('--- componentes bds-* (host) ---');
    deepQueryAll('bds-input, bds-select, bds-textarea, bds-combobox, bds-input-chips').forEach((el, i) => {
      out.push(
        `#${i} <${el.tagName.toLowerCase()}> placeholder="${el.getAttribute('placeholder') || ''}" ` +
          `label="${el.getAttribute('label') || ''}" name="${el.getAttribute('name') || ''}"`
      );
    });
    out.push('--- linhas de dias (Programação) ---');
    DIAS_LABEL.forEach((d) => {
      const linha = acharLinhaDoDia(d);
      if (!linha) {
        out.push(`${d}: NÃO ENCONTRADO`);
        return;
      }
      const times = deepQueryAll('input[type="time"]', linha).length;
      out.push(`${d}: ${times} time-input(s) / botão+=${acharBotaoMais(linha) ? 'sim' : 'não'} / tag=${linha.tagName}`);
    });
    const texto = out.join('\n');
    console.log('%c[Blip Horários] INSPEÇÃO', 'color:#1968f0;font-weight:bold');
    console.log(texto);
    navigator.clipboard?.writeText(texto).then(
      () => alert('Inspeção copiada para a área de transferência!\nCole aqui no chat para eu ajustar os seletores.'),
      () => alert('Inspeção impressa no Console (F12). Copie de lá.')
    );
  }

  // 5) UI / ORQUESTRAÇÃO
  let grupos = [];

  function logPainel(msg) {
    const txt = Array.isArray(msg) ? msg.join('\n') : msg;
    const el = document.getElementById('bh-log');
    if (el) el.textContent = txt;
    console.log('[Blip Horários]', txt);
  }

  // Estado da automação, persistido (resiste a recarregamento da página)
  const STATE_KEY = 'bhAutoState';
  function getState() {
    const s = GM_getValue(STATE_KEY, { running: false, grupos: [], done: [], semAtendentes: [] });
    if (!s.semAtendentes) s.semAtendentes = [];
    return s;
  }
  function setState(s) {
    GM_setValue(STATE_KEY, s);
  }

  function waitFor(fn, timeout, intervalo) {
    timeout = timeout || 12000;
    intervalo = intervalo || 250;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const id = setInterval(() => {
        let ok = false;
        try {
          ok = fn();
        } catch (e) {}
        if (ok) {
          clearInterval(id);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(id);
          resolve(false);
        }
      }, intervalo);
    });
  }

  function acharBotaoPorTexto(txt) {
    const alvo = normalizar(txt);
    const cands = deepQueryAll('bds-button, button, [role="button"], a').filter((b) => b.offsetParent !== null);
    return (
      cands.find((b) => normalizar(b.textContent || '') === alvo) ||
      cands.find((b) => normalizar(b.textContent || '').includes(alvo)) ||
      null
    );
  }

  // bds-button tem um <button> interno no Shadow DOM
  function clicarBotao(b) {
    const sr = b.shadowRoot;
    realClick((sr && sr.querySelector('button')) || b);
  }

  function formAberto() {
    return !!acharSecaoPorTitulo('Nome e descrição');
  }

  function inputNomeAtual() {
    const sec = acharSecaoPorTitulo('Nome e descrição');
    if (!sec) return null;
    let node = sec;
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (node && deepQueryAll('input, textarea', node).length >= 2) {
        return deepQueryAll('input, textarea', node)[0];
      }
    }
    return null;
  }

  async function abrirFormCriar() {
    const btn = acharBotaoPorTexto('Criar horário');
    if (!btn) return false;
    clicarBotao(btn);
    // espera um formulário FRESCO (Nome presente e 1º campo vazio)
    return await waitFor(() => {
      const inp = inputNomeAtual();
      return inp && (inp.value || '') === '';
    }, 12000);
  }

  async function salvar() {
    const btn = acharBotaoPorTexto('Salvar alterações');
    if (!btn) return false;
    clicarBotao(btn);
    await waitFor(
      () => !formAberto() || acharPorTextoContendo('sucesso', 80) || acharPorTextoContendo('salvo', 80),
      12000
    );
    await sleep(1000);
    return true;
  }

  // Detecta filas já criadas pelo texto da página (nome no formato "Fila|...")
  function textoDaPagina() {
    let t = document.body ? document.body.innerText : '';
    try {
      t += ' ' + deepQueryAll('bds-typo').map((e) => e.textContent || '').join(' ');
    } catch (e) {}
    return normalizar(t);
  }
  function coletarJaCriadasDaPagina(lista) {
    const t = textoDaPagina();
    const set = new Set();
    lista.forEach((g) => {
      if (t.includes(normalizar(g.fila + '|'))) set.add(g.fila);
    });
    return set;
  }

  let rodando = false;
  async function autoLoop() {
    if (rodando) return;
    rodando = true;
    try {
      let st = getState();
      if (!st.running) {
        rodando = false;
        return;
      }
      if (st.grupos && st.grupos.length) grupos = st.grupos;
      if (!grupos.length) {
        logPainel('⚠️ Nenhuma fila carregada. Carregue a planilha e inicie de novo.');
        st.running = false;
        setState(st);
        rodando = false;
        return;
      }

      // pula as filas que já aparecem na lista da página
      const jaPagina = coletarJaCriadasDaPagina(grupos);
      if (jaPagina.size) {
        st = getState();
        jaPagina.forEach((f) => {
          if (!st.done.includes(f)) st.done.push(f);
        });
        setState(st);
        logPainel(`ℹ️ ${jaPagina.size} fila(s) já existente(s) — serão puladas.`);
        await sleep(800);
      }

      while (true) {
        const s = getState();
        if (!s.running) {
          logPainel('⏹ Automação parada.');
          break;
        }
        const proxima = grupos.find((g) => !s.done.includes(g.fila));
        if (!proxima) {
          s.running = false;
          setState(s);
          const linhas = [`✅ Concluído! ${s.done.length}/${grupos.length} fila(s) processadas.`];
          if (s.semAtendentes.length) {
            linhas.push('', `⚠️ ${s.semAtendentes.length} fila(s) SEM atendentes cadastrados:`);
            s.semAtendentes.forEach((f) => linhas.push('  • ' + f));
          } else {
            linhas.push('', '👍 Todas as filas tiveram atendentes cadastrados.');
          }
          logPainel(linhas);
          break;
        }

        logPainel(`▶ (${s.done.length + 1}/${grupos.length}) Criando "${proxima.fila}"...`);
        const abriu = await abrirFormCriar();
        if (!abriu) {
          logPainel('⚠️ Não consegui abrir o formulário ("Criar horário"). Automação parada.');
          s.running = false;
          setState(s);
          break;
        }
        await sleep(400);

        const rel = [];
        const resultado = await preencherCampos(proxima, rel);
        console.log('[Blip Horários] ' + proxima.fila + ': ' + rel.join(' | '));
        if (!resultado || !resultado.atendentesOk) {
          const sa = getState();
          if (!sa.semAtendentes.includes(proxima.fila)) {
            sa.semAtendentes.push(proxima.fila);
            setState(sa);
          }
        }
        await sleep(700);

        const salvou = await salvar();
        if (!salvou) {
          logPainel('⚠️ Botão "Salvar alterações" não encontrado. Automação parada.');
          s.running = false;
          setState(s);
          break;
        }

        const s2 = getState();
        if (!s2.done.includes(proxima.fila)) s2.done.push(proxima.fila);
        setState(s2);
        logPainel(`✅ "${proxima.fila}" salva (${s2.done.length}/${grupos.length}).`);
        await sleep(1500);
      }
    } catch (e) {
      logPainel('❌ Erro no loop: ' + e.message);
      const s = getState();
      s.running = false;
      setState(s);
    }
    rodando = false;
  }

  function iniciarAuto() {
    if (!grupos.length) {
      logPainel('Carregue a planilha primeiro.');
      return;
    }
    setState({ running: true, grupos, done: [], semAtendentes: [] });
    logPainel('▶ Iniciando automação...');
    autoLoop();
  }
  function pararAuto() {
    const s = getState();
    s.running = false;
    setState(s);
    logPainel('⏹ Parando após o passo atual...');
  }

  function criarUI() {
    if (document.getElementById('blip-horarios-panel')) return;

    const css = document.createElement('style');
    css.textContent = `
      #blip-horarios-btn{position:fixed;right:18px;bottom:18px;z-index:999999;background:#1968f0;color:#fff;
        border:none;border-radius:24px;padding:10px 16px;font:600 13px sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25)}
      #blip-horarios-panel{position:fixed;right:18px;bottom:64px;z-index:999999;width:340px;background:#fff;color:#222;
        border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);font:13px sans-serif;padding:14px;display:none}
      #blip-horarios-panel h3{margin:0 0 8px;font-size:14px}
      #blip-horarios-panel input,#blip-horarios-panel select{width:100%;box-sizing:border-box;padding:7px;margin:4px 0;
        border:1px solid #ccc;border-radius:6px;font-size:12px}
      #blip-horarios-panel button{cursor:pointer;border:none;border-radius:6px;padding:8px;font-weight:600;font-size:12px}
      .bh-primary{background:#1968f0;color:#fff;width:100%}
      .bh-auto{background:#0a8f3c;color:#fff;width:100%;margin-top:6px}
      .bh-stop{background:#fde8e8;color:#c0392b;width:100%;margin-top:6px}
      .bh-second{background:#eef;color:#1968f0;width:100%;margin-top:6px}
      #bh-log{margin-top:8px;max-height:160px;overflow:auto;font:11px/1.4 monospace;background:#f6f6f8;padding:8px;border-radius:6px;white-space:pre-wrap}
    `;
    document.head.appendChild(css);

    const btn = document.createElement('button');
    btn.id = 'blip-horarios-btn';
    btn.textContent = '⚙ Blip Horários';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'blip-horarios-panel';
    panel.innerHTML = `
      <h3>Blip · Horários de Atendimento</h3>
      <input id="bh-url" placeholder="URL da planilha do Google Sheets" />
      <button class="bh-primary" id="bh-load">Carregar planilha</button>
      <button class="bh-auto" id="bh-auto">▶ Criar TODAS as filas</button>
      <button class="bh-stop" id="bh-stop">⏹ Parar</button>
      <hr style="border:none;border-top:1px solid #eee;margin:8px 0">
      <select id="bh-fila"><option>— carregue a planilha —</option></select>
      <button class="bh-second" id="bh-fill" style="margin-top:6px">Preencher 1 fila (teste)</button>
      <button class="bh-second" id="bh-inspect">Inspecionar campos</button>
      <div id="bh-log">Pronto.</div>
    `;
    document.body.appendChild(panel);

    const log = logPainel;

    btn.onclick = () => {
      panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'block' : 'none';
    };

    const savedUrl = GM_getValue('sheetUrl', '');
    if (savedUrl) document.getElementById('bh-url').value = savedUrl;

    document.getElementById('bh-load').onclick = async () => {
      const url = document.getElementById('bh-url').value.trim();
      const csvUrl = urlParaCsv(url);
      if (!csvUrl) return log('❌ URL inválida do Google Sheets.');
      GM_setValue('sheetUrl', url);
      log('Baixando planilha...');
      try {
        const csv = await baixarCsv(csvUrl);
        grupos = montarGrupos(parseCsv(csv));
        document.getElementById('bh-fila').innerHTML = grupos
          .map((g, i) => `<option value="${i}">${g.fila} (${g.atendentes.length} atend.)</option>`)
          .join('');
        log(`✅ ${grupos.length} fila(s) carregada(s).`);
      } catch (e) {
        log('❌ ' + e.message + '\n\nDica: a planilha precisa estar como "Qualquer pessoa com o link -> Leitor".');
      }
    };

    document.getElementById('bh-fill').onclick = async () => {
      const i = parseInt(document.getElementById('bh-fila').value, 10);
      if (isNaN(i) || !grupos[i]) return log('Selecione uma fila primeiro.');
      const rel = [`Preenchendo fila "${grupos[i].fila}"...`, ''];
      log(rel);
      try {
        await preencherCampos(grupos[i], rel);
      } catch (e) {
        rel.push('❌ Erro: ' + e.message);
      }
      rel.push('', '➡️ Revise e clique em "Salvar alterações" no Blip.');
      log(rel);
    };

    document.getElementById('bh-auto').onclick = iniciarAuto;
    document.getElementById('bh-stop').onclick = pararAuto;
    document.getElementById('bh-inspect').onclick = inspecionar;

    // Se a página recarregou no meio da automação, retoma
    if (getState().running) {
      panel.style.display = 'block';
      logPainel('↻ Retomando automação após recarregar...');
      setTimeout(autoLoop, 2000);
    }
  }

  window.__blipHorarios = { parseHorario, montarGrupos, parseCsv };

  // 6) Mostra o painel SÓ na página de "Horários de atendimento" (Blip é SPA: observa a URL)
  function naPaginaHorarios() {
    return /attendance-hours/i.test(location.href);
  }
  function removerUI() {
    ['blip-horarios-panel', 'blip-horarios-btn'].forEach((id) => {
      const e = document.getElementById(id);
      if (e) e.remove();
    });
  }
  function avaliarPagina() {
    if (naPaginaHorarios()) criarUI();
    else removerUI();
  }

  let ultimaUrl = location.href;
  setInterval(() => {
    if (location.href !== ultimaUrl) {
      ultimaUrl = location.href;
      avaliarPagina();
    }
  }, 1000);

  if (document.body) avaliarPagina();
  else window.addEventListener('DOMContentLoaded', avaliarPagina);
})();
