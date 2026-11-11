# Monitores Central

Aplicativo desktop (Electron + backend Python + JavaScript) desenvolvido para centralizar consultas operacionais de pedidos e chamados e reduzir atividades manuais de acompanhamento. Integra fluxos de múltiplos sistemas e fornece painéis locais.

**Status:** código público de referência/portfólio. Integrações externas dependem de autorização, configuração de credenciais e dados locais. Este repositório não inclui dados operacionais ou credenciais, e não demonstra sozinho um instalador pronto para distribuição.

## Tecnologias
- Electron/Node.js para interface e execução desktop
- Python com servidor HTTP e integrações de APIs
- JavaScript, HTML e CSS
- Processamento de dados JSON e CSV, atualização periódica e caches locais

## Execução para desenvolvimento
1. Instale Node.js, Python e dependências Python requeridas pelo código.
2. Execute `npm install`.
3. Copie `.env.example` para `.env` e use **somente credenciais novas, válidas e autorizadas**. Nunca commitá-las.
4. Execute `npm start` em ambiente de desenvolvimento autorizado.

O arquivo `.env.example` é apenas um modelo. O projeto pode exigir configurações adicionais para as integrações usadas. Não use dados reais em demonstrações públicas.

## Segurança e distribuição
Consulte [SECURITY_CONFIGURATION.md](SECURITY_CONFIGURATION.md) antes de executar ou empacotar. Versões anteriores expuseram credenciais e caches em Git; os valores precisam ser revogados/rotacionados e o histórico precisa de saneamento coordenado. A configuração atual do instalador exclui `.env` e caches, mas **a distribuição segura de credenciais ainda precisa ser projetada e testada**.

## Escopo e limitações
Este repositório representa um projeto de automação/integração desenvolvido no contexto de atividades profissionais. Não há garantia de que os sistemas externos continuem acessíveis. Dados operacionais devem permanecer privados; o código público não concede acesso a APIs nem direitos sobre informações de terceiros.
Nota: o histórico público foi consolidado após a remoção de credenciais.
