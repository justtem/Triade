# Política de Segurança — AI Council

Este documento apresenta o modelo de ameaças, as camadas de defesa implementadas (incluindo o **Sandbox do Modo Construtor**, o **Expansor OWASP/LGPD**, o **Mini-Auditor 0 ms** e o **Preview App local**), os limites conhecidos e o processo de reporte responsável de vulnerabilidades do **AI Council**.

> Para detalhes sobre fluxo de dados pessoais, operadores externos e direitos de privacidade (LGPD), consulte [PRIVACY.md](PRIVACY.md).

---

## 1. Modelo de Ameaças e Princípios

O **AI Council** é uma aplicação **local-first** executada na máquina do usuário (`127.0.0.1:4317`), com suporte opcional a acesso remoto protegido por senha (rede local ou túnel HTTPS privado).

O projeto adota **Defesa em Profundidade**, **Menor Privilégio**, **Fail-Closed** em controles críticos e **Privacidade desde a Concepção**:
- Nenhuma credencial ou segredo é exposto ao navegador ou versionado no Git.
- Operações administrativas, escrita em arquivos do PC, execução de testes e inicialização de servidores locais são restritas exclusivamente ao acesso direto em `localhost` (**HTTP 403** em acesso remoto ou via proxy).
- Conteúdo externo (páginas web, PDFs, anexos, código de projetos e saídas de LLMs) é tratado como entrada não confiável em todas as camadas.

---

## 2. Controles de Segurança por Camada

| Camada | Controles Implementados |
| :--- | :--- |
| **Autenticação & Sessões** | Tokens opacos aleatórios (`randomBytes(32)`), armazenados no servidor apenas como **hash SHA-256**, trafegando exclusivamente por cookie `HttpOnly; SameSite=Lax` (`Secure` atrás de proxy HTTPS), com expiração, limite de sessões ativas e revogação real no logout ou na troca de senha. Proteção contra força bruta (**5 tentativas / 15 min → HTTP 429 + `Retry-After`**). |
| **Isolamento Localhost-Only** | Retornam **HTTP 403** para qualquer conexão remota ou via proxy: Setup de chaves (`/setup/*`), gestão do cofre local (`/privacy/vault/*`), vínculo/inspeção/seletor de pastas e criação de subpastas (`/projects/pick-folder`, `/projects/create-subfolder`, `/projects/inspect-folder`), Briefing 1-Frase (`/projects/briefing/*`), Modo Construtor (`/debates/:id/builder/*`), Preview App (`/projects/:id/dev-server/*`), aplicação de permissões NTFS e eliminação total de dados. Cabeçalhos `X-Forwarded-*` só são aceitos quando originados em loopback local. |
| **Sandbox do Modo Construtor (Escrita, Remoção & Backup)** | Resolução canônica (`realpath` + `lstat` em cada segmento do caminho) bloqueando *path traversal* (`..`), caminhos absolutos, symlinks apontando para fora da pasta vinculada, nomes reservados do Windows (`CON`, `NUL`, `COM1`..), diretórios sensíveis (`.git`, `node_modules`, `.ssh`, `.gnupg`, `.ai-council-backup`) e arquivos sensíveis/binários (`.env*`, `*.key`, `*.pem`, `*.pfx`, `*.exe`, `*.dll`, `*.sqlite`). Diretivas de remoção (`DELETE:`) só são aceitas fora de blocos de código, limitadas a 10 arquivos regulares por lote (nunca diretórios) e sempre com backup prévio em `.ai-council-backup/<batchId>/` restaurável pelo **`Desfazer`**. |
| **Execução Allowlisted (Build/Test & Preview App)** | **Nenhuma instrução ou comando arbitrário de shell vindo de prompts ou respostas da IA é executado.** O verificador e o gerenciador de preview executam exclusivamente scripts fixos de `package.json` (`install`, `build`, `tsc --noEmit`, `test`, `dev`, `start`) com `shell: false`, `windowsHide: true` e `HOST=127.0.0.1` forçado. O Preview App aceita apenas portas loopback válidas (`1024..65535`, bloqueando `4317`), limita a 3 servidores simultâneos, auto-encerra após 30 min ocioso e mata toda a árvore de processos (`taskkill /T /F` no Windows) em timeout, cancelamento ou saída do servidor. |
| **Expansor OWASP/LGPD & Mini-Auditor 0 ms** | No Briefing 1-Frase, injeta regras proporcionais de segurança (*Base OWASP*, *Financeiro* e *Privacidade/LGPD*) usando recursos nativos do Node.js (sem dependências pesadas não solicitadas) e trava negativa para jogos/simulações. Após `build` e `test`, o Mini-Auditor estático (0 ms) verifica o código gerado e reprova falhas críticas (`innerHTML`/`outerHTML` dinâmico, `document.write`, bind em `0.0.0.0`, `md5`/`sha1`/`sha256` em senha, `console.log` de PII/segredos, `eval`/`new Function`), disparando o **Auto-Fix** automaticamente antes de aprovar o card. |
| **Defesa Web, CSP & Rede** | `Content-Security-Policy` 100% self-hosted (`default-src 'self'`, `script-src 'self'`, `font-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, **zero CDNs externas**), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` e HSTS atrás de proxy HTTPS. Defesa CSRF contra requisições mutáveis `Sec-Fetch-Site: cross-site`. |
| **Anti-Abuso & Disponibilidade** | Rate-limiting por IP e categoria de rota (`429` + `Retry-After`), limites rígidos de tamanho de payload, timeouts HTTP explícitos (`headersTimeout`, `keepAliveTimeout`, `requestTimeout`) e teto de conexões SSE simultâneas. |
| **Anti-SSRF (Busca Web & URLs)** | Bloqueio de loopback, IPs privados/LAN/CGNAT/link-local e protocolos não-HTTP, com resolução DNS prévia contra *DNS rebinding* e validação manual de cada salto de redirecionamento (`redirect: "manual"`). |
| **Prompt Injection & XSS** | Isolamento de páginas web, anexos e arquivos de Projetos em blocos `<untrusted_data>` (com escape de tag) + instruções anti-injeção nos system prompts. Renderização de Markdown segura via DOM, neutralização de imagens externas (anti-exfiltração), `KaTeX` com `trust: false`, `Mermaid` com `securityLevel: "strict"` + sanitizador próprio de SVG e uso rigoroso de `textContent` nos painéis interativos (paleta, atalhos, briefing e preview). |
| **Prevenção de Vazamento (DLP + OCR)** | Escudo de Privacidade híbrido com detecção de chaves de API, chaves PEM, JWT, credenciais, CPF/CNPJ (Mod-11), cartões (Luhn), e-mails e telefones. Confirmação interativa para mensagens/prints (com **OCR local offline** no Windows e tarja visual via `<canvas>`) e mascaramento automático de anexos, PDFs e arquivos de Projetos. |
| **Criptografia em Repouso & Persistência Atômica** | Criptografia opcional **`AES-256-GCM`** para conversas, projetos, templates, memória, eventos e selagem opcional de chaves de API (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` e `NVIDIA_API_KEY` opcional) — via **Windows DPAPI** ou **Senha Mestra** (*Envelope Encryption* com `scrypt`, Chave de Recuperação, chave mantida apenas em RAM, auto-bloqueio por inatividade e zeramento de buffer com `Buffer.fill(0)`). Gravação atômica via `.tmp` + `rename` com retry exponencial contra locks NTFS (`atomic-fs.ts`) e permissão restrita (`0o600` / NTFS exclusivo ao usuário + `SYSTEM`). |
| **Trava de Custo Zero** | Validação fail-closed nos provedores: `OpenRouter` aceita apenas modelos `:free` com preço explicitamente zerado; auto-descoberta do `Gemini` usa allowlist restrita às famílias `Flash`/`Gemma`; `NVIDIA NIM` opera na conta gratuita sem cartão (`build.nvidia.com`) com filtro de modelos de chat/código; `UsageGate` impõe margem preventiva de 90%. |

---

## 3. Verificação Contínua Automatizada

O projeto inclui um gate automatizado de segurança executável localmente ou em CI:

```bash
npm run security:check
```

Os 5 controles verificados continuamente são:
1. **Segredos e Dados Pessoais no Git:** garante ausência de `.env`, `data/`, chaves hardcoded, hostnames/IPs privados ou caminhos locais pessoais em todos os arquivos rastreados.
2. **CSP e Ativos 100% Locais:** valida diretivas críticas da CSP e ausência de CDNs externas no HTML.
3. **Dependências (`npm audit`):** verifica vulnerabilidades conhecidas na árvore de dependências.
4. **Permissões de Sistema (Windows NTFS):** valida restrição de acesso aos diretórios locais sensíveis.
5. **Suítes de Segurança & Integridade ESM:** executa testes automatizados de autenticação, CSRF, rate-limit, anti-SSRF, DLP, criptografia, Prompt Injection, XSS e integridade acíclica do frontend.

A suíte completa (`npm test`) executa **131 testes em 26 suítes**, incluindo cobertura dedicada para sandbox de escrita/remoção, bloqueio remoto `403`, Briefing OWASP/LGPD, Mini-Auditor estático 0 ms, gerenciamento de Preview App, Setup/Cofre com provedor opcional (`NVIDIA NIM`), failover e contrato do Construtor.

---

## 4. Limitações Conhecidas e Responsabilidade do Usuário

Nenhum software oferece segurança absoluta. Ao utilizar o AI Council, considere os seguintes limites:

- **Protótipos gerados pelo Briefing/Construtor não equivalem a certificação legal:** o Expansor OWASP/Financeiro/LGPD e o Mini-Auditor estático 0 ms aplicam boas práticas técnicas desde o protótipo local, mas **não garantem conformidade jurídica com a LGPD** nem substituem revisão humana, pentest, HTTPS/TLS, banco criptografado, autenticação/RBAC e avaliação jurídica antes de colocar qualquer app gerado em produção pública.
- **Execução local de scripts do projeto (`npm test` / `npm run dev`):** o AI Council nunca executa comandos arbitrários vindos de prompts ou respostas da IA e isola a escrita na pasta vinculada, porém scripts existentes no `package.json` de um projeto local rodam com os privilégios da sessão do usuário. Em projetos de terceiros ou código sensível, utilize a política **`Perguntar antes`** (ou **`Somente leitura`**) no menu **`!`** da pasta para revisar o diff antes de executar.
- **Sistema operacional comprometido:** controles em nível de aplicação não protegem contra malware ativo com privilégios na sessão do usuário (ex.: *keyloggers* ou leitura direta da RAM enquanto o cofre estiver destrancado). Mantenha o SO atualizado, antivírus ativo e criptografia de disco (como BitLocker/FileVault) habilitada.
- **Limites do OCR local:** a detecção de texto sensível em imagens funciona bem em capturas de tela nítidas, mas pode falhar em fotos borradas, fontes muito pequenas ou escrita manual; revise e utilize o editor de tarja manual quando necessário.
- **Exposição de rede:** para acesso remoto, prefira túneis privados com HTTPS fim-a-fim (como Tailscale Serve) e senha forte (`12+` caracteres) em vez de expor a porta diretamente na internet pública.
- **Provedores externos:** o conteúdo enviado nas conversas é processado pelas APIs de terceiros configuradas pelo próprio usuário (Google Gemini, Groq, OpenRouter e, quando ativada, NVIDIA NIM), sujeitas às políticas de privacidade de cada provedor — nos planos gratuitos (incluindo Google AI Studio fora da UE e NVIDIA Developer Trial), os prompts podem ser usados para melhoria de serviços/modelos; evite enviar senhas ou dados pessoais sensíveis.

---

## 5. Reporte Responsável de Vulnerabilidades

Caso identifique uma falha de segurança neste projeto:

1. **Não** abra issues públicas contendo provas de conceito exploráveis, credenciais ou detalhes que facilitem exploração.
2. Utilize o recurso privado **GitHub Security Advisories** deste repositório (ou entre em contato diretamente com o mantenedor) informando descrição técnica, passos para reprodução e impacto estimado.
3. Relatos válidos serão analisados com prioridade para correção, teste de regressão e divulgação coordenada.
