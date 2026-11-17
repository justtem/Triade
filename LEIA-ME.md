# AI Council — Intelligence Hub

> **Plataforma local de orquestração de debates técnicos multi-IA em rodadas estruturadas, com execução automática via APIs gratuitas, proteção rigorosa de limites (`UsageGate`) e interface conversacional inspirada no Eraser Design System.**

*(Consulte também o arquivo [README.md](./README.md) para a documentação técnica completa com diagramas de arquitetura e referência detalhada da API HTTP).*

---

## 1. Visão Geral

O **AI Council** coordena múltiplas inteligências artificiais para analisar problemas técnicos, realizar críticas cruzadas entre pares e consolidar uma **Síntese e Conclusão Conjunta em Markdown**:

- **Assentos Automáticos (API):** `Gemini`, `Groq` e `OpenRouter (:free)` respondem automaticamente em paralelo pelo runner interno do servidor.
- **Assentos Manuais Opcionais:** `ChatGPT` e `Claude` podem ser selecionados no Composer para colagem manual de respostas, sem automação intrusiva na web.
- **Interface Clean Chat + Eraser Design System:**
  - **Sidebar Esquerda Retrátil:** Navegação em abas (*Chat Central*, *Resumo & Monitoramento*, *Atividade & Histórico*) e histórico colapsável de conversas.
  - **Palco Central (`860px`):** Acordeões retráteis de raciocínio em tempo real (`Pensando... 00:00.0s` → `Pensou por X.Xs — Rodada N`), cards de resposta colapsáveis com cópia de Markdown/código e **AI Prompt Panel** na base.
  - **Dock Direito Compacto (`240px`):** Monitoramento dedicado às 3 IAs automáticas com ícones vetoriais SVG reais, status/cronômetro ao vivo e micro-barra de limite diário (`reqHoje/reqMax req`).

---

## 2. Instalação e Execução Rápida

1. Configure o arquivo `.env` na raiz do projeto (baseado em `.env.example`) com:
   - `GEMINI_API_KEY`
   - `GROQ_API_KEY`
   - `OPENROUTER_API_KEY`
   - `MONITOR_TOKEN` (mínimo de 32 caracteres)

2. No PowerShell, dentro da pasta do projeto (use `npm.cmd` para evitar bloqueios de política de script):

```powershell
npm.cmd install
npm.cmd run test:providers:dry
npm.cmd run test:providers
npm.cmd run monitor
```

3. Acesse no navegador: **`http://127.0.0.1:4317`**

---

## 3. Como Usar

1. Na tela principal (**Chat Central**), digite o problema no **AI Prompt Panel** na parte inferior.
2. Selecione na barra inferior:
   - **Participantes:** `Gemini`, `Groq` e `OpenRouter` vêm selecionados por padrão (adicione `ChatGPT`/`Claude` se desejar participação manual).
   - **Rodadas:** `1`, `2` ou `3 rodadas + Síntese`.
   - **Foco:** `Geral`, `Backend / código` ou `Frontend`.
   - **+ Opções avançadas (opcional):** defina um título personalizado (gerado automaticamente se vazio) e diretrizes extras.
3. Pressione `Enter` ou clique em **`Iniciar Debate →`**.
4. Acompanhe o cronômetro em tempo real no bloco **Pensando...** e no dock lateral direito até a geração da **Síntese e Conclusão Conjunta (`.md`)**.

---

## 4. Proteções de Custo Zero e Economia de Tokens

- **Trava `:free` no OpenRouter:** qualquer modelo sem o sufixo `:free` é recusado pelo código.
- **UsageGate Local (`data/usage.json`):** interrompe chamadas em 90% (`USAGE_SAFETY=0.9`) do limite diário configurado e aguarda automaticamente janelas de limite por minuto (RPM/TPM).
- **Compactação Entre Rodadas:** respostas anteriores são compactadas preservando início e fim antes de serem enviadas para a rodada de crítica ou síntese.
- **Pausa e Retomada Segura:** em caso de erro `429` ou limite atingido, o debate pausa preservando todas as respostas já obtidas e pode ser retomado do ponto exato pelo botão **`Retomar →`**.
