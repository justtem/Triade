# Local Showcase — Vitrine Interativa para Negócios Locais & Produtos

- **ID:** `local-showcase`
- **Tema:** `light`
- **Vibe:** Editorial orgânico, tátil e envolvente com vitrine interativa central (inspiração Kumo Matcha).
- **Tags:** local, restaurante, cafeteria, loja, estetica, barbearia, padaria, doceria, academia, produto, organico

## Paleta & Tokens (:root)
```css
:root {
  --frame-bg: #7e8247;
  --stage-bg: #26331e;
  --bg: #f6f3eb;
  --surface: #fffdf8;
  --ink: #1c2217;
  --ink-muted: #5b6352;
  --accent: #c89b3c;
  --accent-ink: #17140b;
  --border: #e3decb;
  --radius-stage: 28px;
  --radius-card: 20px;
  --radius-pill: 999px;
}
```
*(Adapte `--frame-bg`, `--stage-bg` e `--accent` à cor natural do negócio — ex.: café/terracota para cafeterias, verde-oliva/creme para gastronomia/estética, grafite/dourado para barbearias — mantendo exatamente a moldura, o contraste e o calor visual.)*

## Tipografia & Hierarquia
- Display editorial limpo + subtítulos quentes; selos de preço e categoria em monospace/tabular-nums nítidos.

## Composição & Seções Obrigatórias
1. **Hero em Moldura Editorial (`--stage-bg` dentro de frame `--frame-bg`):** barra flutuante minimalista com nome da marca e pílula de navegação/CTA, destaque central amplo com `data-image-slot="1"` + **seletor interativo de 4 destaques/sabores/serviços** (cards inclinados/arredondados clicáveis que trocam o título, preço, descrição e selo em tempo real com transição suave!) + CTA direto de **WhatsApp** e **Reservar / Pedir**.
2. **Faixa de Diferenciais Locais:** 3 pilares curtos (ingredientes/qualidade, atendimento rápido, avaliação 4.9★) com ícones SVG monoline.
3. **Cardápio / Catálogo de Serviços com Filtro por Categoria:** tabs funcionais (`Todos`, `Mais Pedidos`, `Combos/Pacotes`), cards com preço, descrição curta e botão rápido *"Pedir no WhatsApp"* pré-preenchido com o nome do item!
4. **Seção "Conheça Nosso Espaço / História":** layout dividido 50/50 com `data-image-slot="2"` e `data-image-slot="3"`, horários de funcionamento, endereço completo, botão *"Abrir no Google Maps"* e prova social de clientes da região.
5. **FAQ Curto + Formulário de Encomenda/Orçamento/Lead + Botão Flutuante Discreto de WhatsApp + Footer.**
