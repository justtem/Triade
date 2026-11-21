# Política de Segurança — AI Council

Este documento apresenta o modelo de ameaças, as camadas de defesa implementadas, os limites conhecidos e o processo de reporte responsável de vulnerabilidades do **AI Council**.

> Para detalhes sobre fluxo de dados pessoais, operadores externos e direitos de privacidade (LGPD), consulte [PRIVACY.md](PRIVACY.md).

---

## 1. Modelo de Ameaças e Princípios

O **AI Council** é uma aplicação **local-first** executada na máquina do usuário (`127.0.0.1:4317`), com suporte opcional a acesso remoto protegido por senha (rede local ou túnel HTTPS privado).

O projeto adota **Defesa em Profundidade**, **Menor Privilégio**, **Fail-Closed** em controles críticos e **Privacidade desde a Concepção**:
- Nenhuma credencial ou segredo é exposto ao navegador ou versionado no Git.
- Operações administrativas e sensíveis são restritas exclusivamente ao acesso direto em `localhost`.
- Conteúdo externo (páginas web, PDFs, anexos e código) é tratado como entrada não confiável em todas as camadas.

---

## 2. Controles de Segurança por Camada

| Camada | Controles Implementados |
| :--- | :--- |
| **Autenticação & Sessões** | Tokens opacos aleatórios (`randomBytes(32)`), armazenados no servidor apenas como **hash SHA-256**, trafegando exclusivamente por cookie `HttpOnly; SameSite=Lax` (`Secure` atrás de proxy HTTPS), com expiração, limite de sessões ativas e revogação real no logout ou na troca de senha. Proteção contra força bruta (**5 tentativas / 15 min → HTTP 429 + `Retry-After`**). |
| **Isolamento Localhost-Only** | Configuração de chaves, gestão do cofre local, vínculo de pastas do sistema, aplicação de permissões NTFS e eliminação total de dados locais retornam **HTTP 403** para qualquer conexão remota ou via proxy. Cabeçalhos de proxy (`X-Forwarded-*`) só são aceitos quando originados em loopback local. |
| **Defesa Web, CSP & Rede** | `Content-Security-Policy` 100% self-hosted (`default-src 'self'`, `script-src 'self'`, `font-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, **zero CDNs externas**), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` e HSTS atrás de proxy HTTPS. Defesa CSRF contra requisições mutáveis `Sec-Fetch-Site: cross-site`. |
| **Anti-Abuso & Disponibilidade** | Rate-limiting por IP e categoria de rota (`429` + `Retry-After`), limites rígidos de tamanho de payload, timeouts HTTP explícitos (`headersTimeout`, `keepAliveTimeout`, `requestTimeout`) e teto de conexões SSE simultâneas. |
| **Anti-SSRF (Busca Web & URLs)** | Bloqueio de loopback, IPs privados/LAN/CGNAT/link-local e protocolos não-HTTP, com resolução DNS prévia contra *DNS rebinding* e validação manual de cada salto de redirecionamento (`redirect: "manual"`). |
| **Prompt Injection & XSS** | Isolamento de páginas web, anexos e arquivos de Projetos em blocos `<untrusted_data>` (com escape de tag) + instruções anti-injeção nos system prompts. Renderização de Markdown segura via DOM, neutralização de imagens externas (anti-exfiltração), `KaTeX` com `trust: false`, `Mermaid` com `securityLevel: "strict"` + sanitizador próprio de SVG e zero `innerHTML` com entradas não confiáveis na paleta/atalhos. |
| **Prevenção de Vazamento (DLP + OCR)** | Escudo de Privacidade híbrido com detecção de chaves de API, chaves PEM, JWT, credenciais, CPF/CNPJ (Mod-11), cartões (Luhn), e-mails e telefones. Confirmação interativa para mensagens/prints (com **OCR local offline** no Windows e tarja visual via `<canvas>`) e mascaramento automático de anexos, PDFs e arquivos de Projetos. |
| **Criptografia em Repouso & Sistema** | Criptografia opcional **`AES-256-GCM`** para conversas, projetos, templates, memória, eventos e selagem opcional de chaves de API — via **Windows DPAPI** ou **Senha Mestra** (*Envelope Encryption* com `scrypt`, Chave de Recuperação, chave mantida apenas em RAM, auto-bloqueio por inatividade e zeramento de buffer com `Buffer.fill(0)`). Restrição de permissões NTFS exclusivas ao usuário local + `SYSTEM` no Windows. |
| **Trava de Custo Zero** | Validação fail-closed nos provedores: `OpenRouter` aceita apenas modelos `:free` com preço explicitamente zerado; auto-descoberta do `Gemini` usa allowlist restrita às famílias `Flash`/`Gemma`; `UsageGate` impõe margem preventiva de 90%. |

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

---

## 4. Limitações Conhecidas e Responsabilidade do Usuário

Nenhum software oferece segurança absoluta. Ao utilizar o AI Council, considere os seguintes limites:

- **Sistema operacional comprometido:** controles em nível de aplicação não protegem contra malware ativo com privilégios na sessão do usuário (ex.: *keyloggers* ou inspeção direta da RAM enquanto o cofre estiver destrancado). Mantenha o SO atualizado, antivírus ativo e criptografia de disco (como BitLocker/FileVault) habilitada.
- **Limites do OCR local:** a detecção de texto sensível em imagens funciona bem em capturas de tela nítidas, mas pode falhar em fotos borradas, fontes muito pequenas ou escrita manual; revise e utilize o editor de tarja manual quando necessário.
- **Exposição de rede:** para acesso remoto, prefira túneis privados com HTTPS fim-a-fim (como Tailscale Serve) e senha forte (`12+` caracteres) em vez de expor a porta diretamente na internet pública.
- **Provedores externos:** o conteúdo enviado nas conversas é processado pelas APIs de terceiros configuradas pelo próprio usuário, sujeitas às políticas de privacidade de cada provedor.

---

## 5. Reporte Responsável de Vulnerabilidades

Caso identifique uma falha de segurança neste projeto:

1. **Não** abra issues públicas contendo provas de conceito exploráveis, credenciais ou detalhes que facilitem exploração.
2. Utilize o recurso privado **GitHub Security Advisories** deste repositório (ou entre em contato diretamente com o mantenedor) informando descrição técnica, passos para reprodução e impacto estimado.
3. Relatos válidos serão analisados com prioridade para correção, teste de regressão e divulgação coordenada.
