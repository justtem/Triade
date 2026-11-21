# Política de Segurança — AI Council

Este documento descreve a arquitetura de segurança, os controles implementados e as limitações conhecidas do **AI Council** (execução local-first no seu computador).

---

## 1. Modelo de Ameaças e Fronteiras de Confiança

O AI Council foi projetado para rodar localmente no PC do usuário (`127.0.0.1:4317`) com acesso remoto opcional protegido por senha (via Wi-Fi local ou Tailscale Serve HTTPS).

### Controles Implementados

- **Autenticação e Sessões Remotas ([src/server/auth.ts](src/server/auth.ts)):**
  - Sessões remotas utilizam tokens opacos aleatórios (`randomBytes(32)`), armazenados no servidor apenas como **hash SHA-256** (`data/sessions.json`, TTL 30 dias, teto de 25 sessões) com revogação real no `POST /auth/logout` e na troca de senha.
  - Sessões trafegam exclusivamente por cookie `HttpOnly; SameSite=Lax` (e `Secure` atrás de proxy HTTPS), nunca expostas em `localStorage` nem query strings.
  - Rate-limit no `/auth/login` e no destrancamento do cofre: **5 falhas em 15 minutos → bloqueio temporário (`429 Too Many Requests` + `Retry-After`)**.
  - Cabeçalhos de proxy (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`) só são confiados quando o socket vem de loopback local.

- **Isolamento de Operações Sensíveis (Localhost-Only):**
  - Setup de chaves (`/setup/*`), vinculação/inspeção de pastas do PC (`/projects/inspect-folder`, `linkedFolderPath`), gestão do cofre local (`/privacy/vault/*`), aplicação de permissões NTFS (`/privacy/ntfs-harden`) e eliminação total (`/privacy/wipe`) são bloqueados com **`403`** para qualquer acesso remoto/proxy.

- **Defesa Web, Tráfego e Rede ([src/server/http-utils.ts](src/server/http-utils.ts), [src/server/app.ts](src/server/app.ts), [src/web/web-context.ts](src/web/web-context.ts), [src/security/rate-limiter.ts](src/security/rate-limiter.ts)):**
  - Cabeçalhos de segurança obrigatórios: `Content-Security-Policy` 100% self-hosted (`default-src 'self'`, `script-src 'self'`, `font-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, zero CDNs externas), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` e `Strict-Transport-Security` (HSTS) atrás de proxy HTTPS local.
  - Fontes (`Inter`, `JetBrains Mono`, `Oswald`) auto-hospedadas localmente em `public/fonts/` sem chamadas ao Google Fonts.
  - Defesa em profundidade contra CSRF bloqueando requisições mutáveis com `Sec-Fetch-Site: cross-site` (`403`).
  - Rate-limit geral por IP e categoria de rota (`ai_write`, `audio`, `privacy_heavy`, `api_general`) retornando `429` + `Retry-After`.
  - Timeouts explícitos no servidor HTTP (`headersTimeout`, `keepAliveTimeout`, `requestTimeout`) e limite máximo de conexões SSE simultâneas (`20`).
  - **Anti-SSRF completo na leitura de URLs:** bloqueia IPs privados/loopback/LAN/CGNAT/Tailscale, resolve DNS antes de conectar (`isSafeResolvedUrl` contra DNS rebinding) e valida manualmente cada salto de redirecionamento (`redirect: "manual"`, máx. 3 saltos).

- **Defesa contra Prompt Injection Indireto e XSS no Markdown ([src/security/prompt-defense.ts](src/security/prompt-defense.ts), [public/js/markdown.js](public/js/markdown.js)):**
  - Páginas web, anexos, PDFs e arquivos de Projetos são isolados em delimitadores `<untrusted_data>` (com escape de fuga de tag e heurística de alerta) e regra explícita anti-injeção nos system prompts.
  - Renderizador Markdown neutraliza imagens externas (`![...](http...)`, anti-exfiltração) e permite links clicáveis estritamente `http:`/`https:` com `noopener noreferrer`.

- **Escudo de Privacidade — DLP Híbrido + OCR Local ([src/security/privacy-shield.ts](src/security/privacy-shield.ts), [src/security/image-ocr.ts](src/security/image-ocr.ts)):**
  - Detecta chaves de API, chaves privadas PEM, JWT, senhas, CPF (Mod-11), CNPJ (Mod-11), cartões de crédito (Luhn) e, no modo **Estrito** (padrão), e-mails e telefones.
  - Pausa com alerta (`409`) antes de enviar texto digitado ou prints com dados sensíveis; mascara automaticamente anexos de texto, PDFs (removendo o binário bruto quando há achados) e arquivos de Projetos.
  - No Windows 10/11, inspeciona imagens anexadas offline com `Windows.Media.Ocr` e oferece tarja automática (`<canvas>`) e editor de tarja manual antes do envio.

- **Proteção de Dados em Repouso ([src/security/data-protection.ts](src/security/data-protection.ts)):**
  - **Permissões NTFS no Windows (`icacls` por SID):** remove herança e restringe `.env` e `data/` exclusivamente à conta do usuário atual e `SYSTEM`.
  - **Criptografia `AES-256-GCM` completa em `data/`** (`sessions/`, `projects/`, `user-memory.json`, `templates.json`, `monitor-events.json` e opcionalmente as 3 chaves de API em `data/.secrets.vault`) em dois modos opcionais:
    1. **DPAPI (1-clique Windows):** chave de 256 bits amarrada ao login Windows (`data/.vault.key`).
    2. **Senha Mestra (Envelope Encryption `scrypt` + `AES-256-GCM`):** chave de dados (DEK) embrulhada pela Senha Mestra + Chave de Recuperação de 24 caracteres (`data/.vault.meta.json`), mantida apenas em RAM enquanto destrancado, com **auto-bloqueio por inatividade** e limpeza de buffer (`Buffer.fill(0)`).

- **Auditoria Contínua Automatizada (`npm run security:check`):**
  - Valida ausência de segredos no Git, integridade da CSP/ativos 100% locais, `npm audit`, permissões NTFS no Windows e todas as suítes de testes de segurança e integridade ESM.

---

## 2. Limitações Conhecidas e Boas Práticas do Usuário

- **Malware ativo na sessão:** nenhum aplicativo local pode vencer um sistema operacional já comprometido em tempo real (ex.: *keylogger* ou leitura direta da RAM enquanto o cofre está destrancado). Mantenha Windows Defender/antivírus, BitLocker e atualizações do SO ativos.
- **OCR em imagens:** o OCR local tem alta precisão em prints de tela, mas pode falhar em fotos borradas, fontes minúsculas ou escrita manual — use o editor de tarja manual quando necessário.
- **Acesso remoto:** prefira **Tailscale Serve** (HTTPS fim-a-fim privado) com `ACCESS_PASSWORD` forte (mínimo 12+ caracteres) em vez de expor portas HTTP na internet pública.
- **Segredos no Git:** nunca versione `.env`, `data/`, `.vault.key` ou `.vault.meta.json` (todos ignorados em `.gitignore`).

---

## 3. Reporte de Vulnerabilidades

Se você encontrar uma vulnerabilidade neste projeto:
1. **Não** publique detalhes exploráveis nem segredos em issues públicas.
2. Abra um aviso privado de segurança (*GitHub Security Advisories*) ou entre em contato diretamente com o mantenedor descrevendo os passos para reproduzir e o impacto estimado.
