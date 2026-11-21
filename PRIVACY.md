# Aviso de Privacidade e Fluxo de Dados — AI Council

O **AI Council** segue uma arquitetura **local-first**: seu histórico, projetos, templates e credenciais ficam armazenados no seu próprio computador, sem nenhum servidor central operado pelo autor do projeto.

---

## 1. Onde seus dados ficam armazenados

| Dado | Onde fica | Proteção técnica disponível |
| :--- | :--- | :--- |
| Chaves de API e senhas (`.env`) | Disco local do PC | Permissões NTFS exclusivas do usuário (`icacls` no Windows) / `0600` |
| Conversas e debates (`data/sessions/`) | Disco local do PC | NTFS + criptografia opcional `AES-256-GCM` (DPAPI ou Senha Mestra) |
| Projetos e arquivos enviados (`data/projects/`) | Disco local do PC | NTFS + criptografia opcional `AES-256-GCM`; pastas vinculadas em modo somente leitura bloqueando `.env`, `.git`, `*.key`, `*.pem` |
| Memória pessoal automática (`data/user-memory.json`) | Disco local do PC | Filtro anti-segredos + visualização, pausa e exclusão por item no Monitor |
| Sessões remotas (`data/sessions.json`) | Disco local do PC | Apenas hash SHA-256 + expiração (30 dias) + revogação no logout |

---

## 2. Operadores externos que recebem dados durante o uso

O AI Council **não coleta telemetria própria**, mas envia exclusivamente o conteúdo necessário para responder às suas solicitações às APIs configuradas por você:

- **Google Gemini API** — recebe prompts, contexto da conversa, anexos (incluindo imagens e PDFs quando habilitado) e contexto de Projeto.
- **Groq API** — recebe prompts, texto extraído de PDFs/anexos e áudio gravado (quando você usa o microfone / Whisper).
- **OpenRouter API** — recebe prompts, imagens (quando multimodal) e contexto para os modelos `:free` configurados.
- **DuckDuckGo / páginas públicas** — quando o modo **Web** está ativo, envia a consulta de busca ou lê URLs públicas coladas (com bloqueio anti-SSRF).
- **Microsoft Edge TTS** — quando você clica em **Ouvir**, envia o texto da resposta para síntese de voz.

> **Dica de privacidade:** o **Escudo de Privacidade (DLP Híbrido)** vem ligado em modo **Estrito** por padrão para avisar antes do envio de dados sensíveis digitados ou em prints (via OCR local no Windows) e mascarar automaticamente anexos, PDFs e arquivos de Projeto. Você também pode configurar nas contas dos provedores (como *OpenRouter → Settings → Privacy*) restrições contra treinamento com prompts.

---

## 3. Seus Controles de Privacidade (Aba Monitor → Privacidade e dados locais)

- **Transparência:** visualização clara do modo do Escudo DLP, estado do Cofre local e permissões NTFS.
- **Acesso e Correção/Exclusão seletiva:** visualizar, pausar ou excluir qualquer item da Memória Pessoal Automática, conversas ou projetos.
- **Portabilidade (`GET /privacy/export`):** exportação completa em `.json` das suas conversas, projetos, templates e memória — **nunca** inclui `.env`, chaves de API, senhas nem chaves do cofre.
- **Eliminação local (`POST /privacy/wipe` — somente PC local):** apaga permanentemente conversas, projetos, memória, eventos e revoga sessões remotas mediante confirmação explícita (`APAGAR TUDO`), preservando seu `.env`.

---

## 4. Enquadramento LGPD (Lei nº 13.709/2018)

- **Uso pessoal e doméstico:** quando executado localmente por pessoa física para fins exclusivamente particulares e não econômicos, aplica-se a hipótese de exclusão do **Art. 4º, inciso I da LGPD**.
- **Uso comercial ou hospedagem para terceiros:** caso você adapte ou hospede o AI Council como serviço para outras pessoas ou empresas, os controles técnicos deste projeto **não substituem análise jurídica especializada** — será necessário definir controlador, bases legais, Política de Privacidade/Termos de Uso formais, isolamento multi-usuário e contratos de processamento de dados (DPA) com os provedores de IA.
