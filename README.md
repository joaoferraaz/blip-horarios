# Blip · Preencher Horários de Atendimento (via Google Sheets)

Automação que lê uma planilha do **Google Sheets** (colunas `Fila`, `Horario`, `Atendentes`)
e preenche os campos da tela **"Horários de atendimento"** do Blip:

- **Nome** = `Fila|Horario`
- **Descrição** = `Horario`
- **Atendentes** = lista de e-mails (inserção em massa)
- **Filas** = nome da fila
- **Programação** = o horário **destrinchado por dia da semana** (Seg–Dom)

Funciona como **userscript** (roda dentro da própria página do Blip), então você fica
logado normalmente — nenhuma senha fica no código.

---

## 1. Instalar

1. Instale a extensão **Tampermonkey** no seu navegador (Chrome/Edge/Firefox/Opera).
2. Abra o painel do Tampermonkey → **Criar novo script**.
3. Apague o conteúdo padrão, cole todo o conteúdo de `blip-horarios.user.js` e salve (Ctrl+S).
   - Ou: arraste o arquivo `.user.js` para a janela do navegador que o Tampermonkey oferece instalar.

> Se a tela do Blip não estiver em `*.blip.ai`, confira a URL na barra de endereços e
> ajuste a linha `// @match` no topo do script para o domínio correto.

## 2. Preparar a planilha

- A planilha precisa ter um cabeçalho com as colunas: **Fila | Horario | Atendentes**.
- O `Fila` e o `Horario` só precisam aparecer na **primeira linha** de cada grupo;
  os e-mails dos atendentes ficam **um por linha** abaixo.
- Compartilhe a planilha: **Compartilhar → Geral → "Qualquer pessoa cssom o link" → Leitor**.

## 3. Usar

1. Abra a tela **"Horários de atendimento"** do Blip (de preferência na **lista** de horários, para a automação detectar os já criados).
2. Clique no botão flutuante **⚙ Blip Horários** (canto inferior direito).
3. Cole a **URL da planilha** e clique **Carregar planilha**.

### Modo automático (criar todas as filas)
4. Clique em **▶ Criar TODAS as filas**.
5. A automação faz, para cada fila da planilha, em sequência:
   - clica em **"+ Criar horário"**
   - preenche Nome, Descrição, Atendentes (com inserção em massa), Filas e Programação
   - clica em **"Salvar alterações"**
6. Filas **já criadas** (que aparecem na lista) são **puladas** automaticamente.
7. Se a página recarregar no meio, a automação **continua sozinha** de onde parou.
8. Para interromper, clique em **⏹ Parar** (ele para após o passo atual).

### Modo manual (testar uma fila só)
- Escolha a fila no seletor e clique **Preencher 1 fila (teste)** — preenche o formulário aberto, sem salvar.

---

## Formatos de horário suportados

O parser entende, por exemplo:

| Texto na planilha | Resultado |
|---|---|
| `Segunda a Sexta das 09:00 às 17:00 e Sábado de 08:30 às 11:30` | Seg–Sex 09:00→17:00, Sáb 08:30→11:30, Dom sem atendimento |
| `Segunda a Sábado das 10:00 às 21:00 e Domingo de 13:00 às 19:00` | Seg–Sáb 10:00→21:00, Dom 13:00→19:00 |
| `Segunda a Sexta das 10:00 às 21:00, Sábado de 10:00 às 17:00 e Domingo de 14:00 às 19:45` | Seg–Sex 10:00→21:00,Sáb 10:00→17:00 Dom 14:00→19:45 |


Regras: trechos separados por **" e "**; cada trecho é `<dias> das/de HH:MM às HH:MM`;
os dias podem ser um intervalo (`Segunda a Sexta`) ou um dia único (`Sábado`).

---

## Testar o parser no console (F12)

```js
__blipHorarios.parseHorario("Segunda a Sexta das 09:00 às 17:00 e Sábado de 08:30 às 11:30")
```
