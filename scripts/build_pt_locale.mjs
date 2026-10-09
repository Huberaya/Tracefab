/* ==========================================================================
   Genere assets/i18n/pt.json a partir du bundle de reference EN.

   Portugais europeen (pt-PT). Conventions alignees sur les locales soeurs :
     - milliers  : point      1.248
     - decimales : virgule    92,4 %
     - espace insecable fine avant le %  (comme fr/de/es)
     - noms propres, normes et references produit inchanges

   Les cles absentes de la table PT conservent la valeur anglaise ; le script
   les liste explicitement en fin d'execution pour qu'aucun oubli ne passe
   inapercu.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';

global.window = {};
await import('../assets/i18n/en.js');
const EN = global.window.TF_I18N_BUNDLES.en;

const PT = {
  'meta.title': 'TRACEFAB — A camada de inteligência para a cadeia têxtil global',
  'meta.description':
    'A TRACEFAB liga dados de fornecedores, provas, qualidade, rastreabilidade e preparação para o Passaporte Digital do Produto numa só infraestrutura inteligente para marcas de têxtil e vestuário.',

  'common.demoData': 'Dados de demonstração',
  'common.demoNote': 'Todos os valores desta página são dados de demonstração.',
  'common.skip': 'Saltar para o conteúdo principal',

  'nav.why': 'Porquê a TRACEFAB',
  'nav.platform': 'Plataforma',
  'nav.supplyChain': 'Cadeia de fornecimento',
  'nav.productIntel': 'Inteligência de produto',
  'nav.dpp': 'DPP',
  'nav.resources': 'Recursos',
  'nav.signIn': 'Iniciar sessão',
  'nav.demo': 'Pedir uma demonstração',
  'nav.openMenu': 'Abrir menu',
  'nav.language': 'Idioma',

  'hero.label': 'Infraestrutura europeia de dados têxteis',
  'hero.line1': 'Conheça o seu produto.',
  'hero.line2': 'Conheça a sua cadeia de fornecimento.',
  'hero.line3': 'Prove-o.',
  'hero.sub':
    'A TRACEFAB liga dados de fornecedores, provas, qualidade, rastreabilidade e preparação para o Passaporte Digital do Produto numa só infraestrutura inteligente.',
  'hero.ctaPrimary': 'Explorar a TRACEFAB',
  'hero.ctaSecondary': 'Pedir uma demonstração',
  'hero.scroll': 'Revelar o sistema',

  'core.title': 'Núcleo de dados vivo',
  'core.hubSub': 'DADOS × TÊXTIL × CONFIANÇA',
  'core.stat1': '1.248',
  'core.stat1Label': 'Produtos ligados',
  'core.stat2Label': 'Unidades mapeadas',
  'core.stat3': '92,4 %',
  'core.stat3Label': 'Qualidade dos dados',
  'core.footLeft': 'As sete camadas sincronizadas',
  'core.footRight': 'ESPR · AGEC art. 13 · CSRD · GS1 Digital Link',
  'core.inspectHint': 'Passe o cursor sobre uma entidade',

  'core.nodes.suppliers.label': 'Fornecedores',
  'core.nodes.suppliers.meta': 'Do Tier 1 ao Tier 4',
  'core.nodes.suppliers.kind': 'Cadeia de fornecimento · Camada 01',
  'core.nodes.suppliers.r1k': 'Fornecedores ativos',
  'core.nodes.suppliers.r2k': 'Países',
  'core.nodes.suppliers.r3k': 'Qualidade média dos dados',
  'core.nodes.suppliers.r3v': '87 %',

  'core.nodes.products.label': 'Produtos',
  'core.nodes.products.meta': 'Modelos e referências',
  'core.nodes.products.value': '1.248',
  'core.nodes.products.kind': 'Dados de produto · Camada 02',
  'core.nodes.products.r1k': 'Produtos ativos',
  'core.nodes.products.r1v': '1.248',
  'core.nodes.products.r2k': 'Com lista de materiais completa',
  'core.nodes.products.r2v': '1.094',
  'core.nodes.products.r3k': 'Revisões registadas',
  'core.nodes.products.r3v': '4.310',

  'core.nodes.materials.label': 'Materiais',
  'core.nodes.materials.meta': 'Fibras, fios, tecidos',
  'core.nodes.materials.value': '3.106',
  'core.nodes.materials.kind': 'Dados de produto · Camada 02',
  'core.nodes.materials.r1k': 'Registos de material',
  'core.nodes.materials.r1v': '3.106',
  'core.nodes.materials.r2k': 'Matérias certificadas',
  'core.nodes.materials.r2v': '71 %',
  'core.nodes.materials.r3k': 'Composição resolvida',
  'core.nodes.materials.r3v': '94 %',

  'core.nodes.facilities.label': 'Unidades',
  'core.nodes.facilities.meta': 'Locais e processos',
  'core.nodes.facilities.kind': 'Cadeia de fornecimento · Camada 01',
  'core.nodes.facilities.r1k': 'Locais mapeados',
  'core.nodes.facilities.r2k': 'Georreferenciados',
  'core.nodes.facilities.r3k': 'Auditados em 24 meses',

  'core.nodes.documents.label': 'Documentos',
  'core.nodes.documents.meta': 'Cofre de provas',
  'core.nodes.documents.value': '9.847',
  'core.nodes.documents.kind': 'Provas · Camada 03',
  'core.nodes.documents.r1k': 'Documentos armazenados',
  'core.nodes.documents.r1v': '9.847',
  'core.nodes.documents.r2k': 'Lidos automaticamente',
  'core.nodes.documents.r2v': '6.220',
  'core.nodes.documents.r3k': 'Associados a um produto',
  'core.nodes.documents.r3v': '84 %',

  'core.nodes.certifications.label': 'Certificações',
  'core.nodes.certifications.meta': 'Normas e âmbitos',
  'core.nodes.certifications.kind': 'Provas · Camada 03',
  'core.nodes.certifications.r1k': 'Certificados válidos',
  'core.nodes.certifications.r2k': 'A expirar em 90 dias',
  'core.nodes.certifications.r3k': 'Normas abrangidas',

  'core.nodes.evidence.label': 'Provas',
  'core.nodes.evidence.meta': 'Cobertura probatória',
  'core.nodes.evidence.value': '84 %',
  'core.nodes.evidence.kind': 'Provas · Camada 03',
  'core.nodes.evidence.r1k': 'Cobertura de provas',
  'core.nodes.evidence.r1v': '84 %',
  'core.nodes.evidence.r2k': 'Elementos verificados',
  'core.nodes.evidence.r2v': '78 %',
  'core.nodes.evidence.r3k': 'Integridade selada',

  'core.nodes.quality.label': 'Qualidade',
  'core.nodes.quality.meta': 'Escala de confiança de seis níveis',
  'core.nodes.quality.value': '92,4 %',
  'core.nodes.quality.kind': 'Qualidade dos dados · Camada 04',
  'core.nodes.quality.r1k': 'Completude dos dados',
  'core.nodes.quality.r1v': '92,4 %',
  'core.nodes.quality.r2k': 'Taxa de verificação',
  'core.nodes.quality.r2v': '78 %',
  'core.nodes.quality.r3k': 'Questões em aberto',

  'core.nodes.traceability.label': 'Rastreabilidade',
  'core.nodes.traceability.meta': 'Da fibra ao produto',
  'core.nodes.traceability.value': '91 %',
  'core.nodes.traceability.kind': 'Rastreabilidade · Camada 05',
  'core.nodes.traceability.r1k': 'Produtos rastreáveis',
  'core.nodes.traceability.r1v': '91 %',
  'core.nodes.traceability.r2k': 'Cadeias até ao Tier 4',
  'core.nodes.traceability.r2v': '63 %',
  'core.nodes.traceability.r3k': 'Profundidade média da cadeia',
  'core.nodes.traceability.r3v': '7 etapas',

  'core.nodes.dpp.meta': 'Preparação do passaporte',
  'core.nodes.dpp.value': '88 %',
  'core.nodes.dpp.kind': 'DPP · Camada 07',
  'core.nodes.dpp.r1k': 'Preparação DPP',
  'core.nodes.dpp.r1v': '88 %',
  'core.nodes.dpp.r2k': 'Prontos a publicar',
  'core.nodes.dpp.r2v': '1.098',
  'core.nodes.dpp.r3k': 'Bloqueados por falta de provas',

  'ticker.i1': 'França',
  'ticker.i3': 'Itália',
  'ticker.i4': 'Alemanha',
  'ticker.i6': 'Marrocos',
  'ticker.i7': 'Tunísia',
  'ticker.i8': 'Índia',
  'ticker.i10': 'Vietname',
  'ticker.i12': 'Estados Unidos',
  'ticker.i14': 'AGEC artigo 13.º',

  'eco.label': 'A base conectada',
  'eco.line1': 'Todo o seu ecossistema têxtil.',
  'eco.line2': 'Uma só base de dados conectada.',
  'eco.lead':
    'Uma cadeia têxtil não é uma lista de fornecedores. É uma sequência de transformações, cada uma com a sua empresa, o seu local, o seu certificado, o seu documento e o seu nível de prova. A TRACEFAB reúne tudo isso num modelo contínuo — e deixa-o ler uma dimensão de cada vez, ou todas ao mesmo tempo.',
  'eco.hint':
    'Selecione uma etapa para abrir o respetivo dossiê. Ative ou desative dimensões para ler a mesma cadeia sob outra perspetiva.',

  'spine.label': 'Arquitetura da plataforma',
  'spine.line1': 'Sete camadas.',
  'spine.line2': 'Uma cadeia de prova contínua.',
  'spine.lead':
    'Simples de compreender. Profunda de explorar. Poderosa de operar. Cada camada responde a uma pergunta e entrega a resposta à seguinte.',
  'spine.openHint': 'Explorar a camada',

  'spine.layers.l1.num': 'Camada 01',
  'spine.layers.l1.name': 'Cadeia de fornecimento',
  'spine.layers.l1.q': 'Quem produz o quê?',
  'spine.layers.l1.desc':
    'Fornecedores, fábricas, locais, materiais e processos mapeados em todos os níveis — não uma lista de fornecedores, mas uma rede de produção.',
  'spine.layers.l1.chips': 'Fornecedores · Fábricas · Locais · Materiais · Processos',
  'spine.layers.l1.valueLabel': 'Unidades mapeadas',

  'spine.layers.l2.num': 'Camada 02',
  'spine.layers.l2.name': 'Dados de produto',
  'spine.layers.l2.q': 'O que é o produto?',
  'spine.layers.l2.desc':
    'Composição, componentes, materiais e identificadores resolvidos ao nível da percentagem, versionados a cada revisão.',
  'spine.layers.l2.chips': 'Produtos · Composição · Materiais · Componentes · Identificadores',
  'spine.layers.l2.value': '1.248',
  'spine.layers.l2.valueLabel': 'Produtos ligados',

  'spine.layers.l3.num': 'Camada 03',
  'spine.layers.l3.name': 'Provas',
  'spine.layers.l3.q': 'Conseguimos prová-lo?',
  'spine.layers.l3.desc':
    'Documentos, certificados, declarações, auditorias e relatórios de ensaio guardados com emissor, âmbito, validade e selo de integridade.',
  'spine.layers.l3.chips': 'Documentos · Certificados · Declarações · Auditorias · Ensaios',
  'spine.layers.l3.value': '9.847',
  'spine.layers.l3.valueLabel': 'Elementos de prova',

  'spine.layers.l4.num': 'Camada 04',
  'spine.layers.l4.name': 'Qualidade dos dados',
  'spine.layers.l4.q': 'Podemos confiar neles?',
  'spine.layers.l4.desc':
    'Cada valor tem um nível: declarado, documentado, verificado, certificado, a rever ou em falta. A confiança torna-se mensurável.',
  'spine.layers.l4.chips': 'Declarado · Documentado · Verificado · Certificado · A rever · Em falta',
  'spine.layers.l4.value': '92,4 %',
  'spine.layers.l4.valueLabel': 'Qualidade dos dados',

  'spine.layers.l5.num': 'Camada 05',
  'spine.layers.l5.name': 'Rastreabilidade',
  'spine.layers.l5.q': 'De onde veio?',
  'spine.layers.l5.desc':
    'Da fibra ao material, do processamento ao fabrico e ao produto — uma cadeia de custódia contínua, e não alegações soltas.',
  'spine.layers.l5.chips': 'Fibra → Material → Processamento → Fabrico → Produto',
  'spine.layers.l5.value': '91 %',
  'spine.layers.l5.valueLabel': 'Produtos rastreáveis',

  'spine.layers.l6.num': 'Camada 06',
  'spine.layers.l6.name': 'Inteligência',
  'spine.layers.l6.q': 'O que nos dizem os dados?',
  'spine.layers.l6.desc':
    'Risco, lacunas, desempenho dos fornecedores, maturidade do produto e preparação regulamentar calculados a partir dos seus próprios dados — nunca inventados.',
  'spine.layers.l6.chips': 'Risco · Lacunas · Qualidade · Desempenho dos fornecedores · Preparação',
  'spine.layers.l6.valueLabel': 'Sinais em aberto',

  'spine.layers.l7.num': 'Camada 07',
  'spine.layers.l7.q': 'O que podemos publicar?',
  'spine.layers.l7.desc':
    'Um indicador de preparação, um passaporte de produto e uma experiência pública para o consumidor. Um indicador de preparação, nunca uma certificação legal.',
  'spine.layers.l7.chips': 'Preparação DPP · Passaporte de produto · Dados públicos · Vista do consumidor',
  'spine.layers.l7.value': '88 %',
  'spine.layers.l7.valueLabel': 'Preparação DPP',

  'promise.label': 'Porquê a TRACEFAB',
  'promise.line1': 'A camada de inteligência',
  'promise.line2': 'para a cadeia têxtil global.',
  'promise.c1Verb': 'Veja-a.',
  'promise.c1Txt':
    'Cada fornecedor, local, material e transformação num só modelo conectado — incluindo os níveis que nunca conseguiu alcançar.',
  'promise.c2Verb': 'Estruture-a.',
  'promise.c2Txt':
    'Folhas de cálculo e PDF tornam-se dados estruturados, ligados aos produtos, versionados e comparáveis em todo o seu catálogo.',
  'promise.c3Verb': 'Verifique-a.',
  'promise.c3Txt':
    'Cada valor tem um nível de prova, da simples declaração ao certificado de terceiros, com validade e integridade acompanhadas.',
  'promise.c4Verb': 'Prove-a.',
  'promise.c4Txt':
    'Preparação regulamentar, dossiês de auditoria e preparação do Passaporte Digital do Produto gerados a partir dos dados que já possui.',
  'promise.kicker': 'Veja. Estruture. Verifique. Rastreie. Prove.',

  'footer.statement': 'A camada de inteligência para a cadeia têxtil global.',
  'footer.europe': 'Europeia por conceção · Global por arquitetura',
  'footer.colPlatform': 'Plataforma',
  'footer.colDomains': 'Domínios',
  'footer.colResources': 'Recursos',
  'footer.platform2': 'Portal do Fornecedor',
  'footer.platform3': 'Centro de Qualidade',
  'footer.platform4': 'DPP público',
  'footer.domains1': 'Mapeamento da cadeia',
  'footer.domains2': 'Provas e certificações',
  'footer.domains3': 'Qualidade dos dados',
  'footer.domains4': 'Rastreabilidade',
  'footer.domains5': 'Preparação DPP',
  'footer.resources1': 'Arquitetura da plataforma',
  'footer.resources2': 'Sistema de design',
  'footer.resources3': 'Referência da API',
  'footer.resources4': 'Segurança e multi-inquilino',
  'footer.rights': '© 2026 TRACEFAB. Todos os direitos reservados.',
  'footer.legal': 'A preparação DPP é um indicador de preparação, não uma certificação legal.',

  'modal.eyebrow': 'Pedir uma demonstração',
  'modal.title': 'Veja a TRACEFAB na sua própria cadeia de fornecimento.',
  'modal.lead':
    'Fale-nos um pouco da sua organização e preparamos uma apresentação com uma cadeia parecida com a sua.',
  'modal.name': 'Nome completo',
  'modal.email': 'E-mail profissional',
  'modal.company': 'Empresa',
  'modal.role': 'Função',
  'modal.roleBrand': 'Marca / Fabricante',
  'modal.roleSupplier': 'Fornecedor',
  'modal.roleConsultant': 'Consultor / Auditor',
  'modal.roleOther': 'Outro',
  'modal.submit': 'Pedir uma demonstração',
  'modal.cancel': 'Cancelar',
  'modal.close': 'Fechar',
  'modal.successTitle': 'Pedido registado.',
  'modal.successTxt': 'Este formulário de demonstração ainda não está ligado a uma caixa de correio. Nada foi enviado.',

  'lang.en': 'English',
  'lang.fr': 'Français',
  'lang.de': 'Deutsch',
  'lang.it': 'Italiano',
  'lang.es': 'Español',
  'lang.nl': 'Nederlands',
  'lang.pt': 'Português',

  'chain.dimensionsLabel': 'Dimensões',
  'chain.stageLabel': 'Etapa',
  'chain.footLeft': 'Cadeia de demonstração · T-shirt de algodão biológico AW26-0248',
  'chain.footRight': '9 etapas · 4 níveis · 3 países',
  'chain.verticalHint': 'Toque numa etapa para ver os detalhes',
  'chain.dims.supplier': 'Fornecedor',
  'chain.dims.country': 'País',
  'chain.dims.facility': 'Unidade',
  'chain.dims.certificate': 'Certificado',
  'chain.dims.document': 'Documento',
  'chain.dims.quality': 'Qualidade',
  'chain.dims.status': 'Estado',
  'chain.status.verified': 'Verificado',
  'chain.status.certified': 'Certificado',
  'chain.status.documented': 'Documentado',
  'chain.status.review': 'A rever',
  'chain.status.declared': 'Declarado',
  'chain.status.missing': 'Em falta',
  'chain.metricLabels.quality': 'Qualidade dos dados',
  'chain.metricLabels.certificates': 'Certificados',
  'chain.metricLabels.products': 'Produtos',
  'chain.metricLabels.evidence': 'Provas',
  'chain.metricLabels.sites': 'Locais',
  'chain.metricLabels.tier': 'Tier',

  'chain.stages.fiber.name': 'Fibra',
  'chain.stages.fiber.supplier': 'Cooperativa Algodão Vivo',
  'chain.stages.fiber.facility': 'Núcleo agrícola do Baixo Alentejo',
  'chain.stages.fiber.certificate': 'Âmbito GOTS 6.0',
  'chain.stages.fiber.document': 'Certificado de transação',
  'chain.stages.fiber.dossierName': 'Cooperativa Algodão Vivo',
  'chain.stages.fiber.desc':
    'Cooperativa produtora de algodão biológico que fornece fibra em bruto com certificados de transação por lote, reconciliados com o balanço de massa.',

  'chain.stages.material.name': 'Material',
  'chain.stages.material.facility': 'Laboratório de materiais do Porto',
  'chain.stages.material.document': 'Declaração de material',
  'chain.stages.material.desc':
    'Caracterização do material e declaração da mistura. A composição é resolvida ao nível da percentagem e ligada à lista de materiais do produto.',

  'chain.stages.spinning.name': 'Fiação',
  'chain.stages.spinning.facility': 'Fiação de Guimarães',
  'chain.stages.spinning.document': 'Relatório de ensaio laboratorial',
  'chain.stages.spinning.desc':
    'Fiação a anéis de fio biológico penteado. Os relatórios de ensaio estão anexados, mas falta ainda a verificação por terceiros em dois títulos.',

  'chain.stages.weaving.name': 'Tecelagem',
  'chain.stages.weaving.facility': 'Casa de tecelagem de Guimarães',
  'chain.stages.weaving.document': 'Registo de produção',
  'chain.stages.weaving.desc':
    'Casa de malha e tecelagem com tratamento de água em circuito fechado. Prova completa de transferência de custódia registada para cada lote.',

  'chain.stages.dyeing.name': 'Tingimento',
  'chain.stages.dyeing.supplier': 'Tinturaria Adriática',
  'chain.stages.dyeing.country': 'Itália',
  'chain.stages.dyeing.facility': 'Unidade de acabamento de Prato',
  'chain.stages.dyeing.certificate': 'ZDHC MRSL nível 3',
  'chain.stages.dyeing.document': 'Relatório de análise de águas residuais',
  'chain.stages.dyeing.dossierName': 'Tinturaria Adriática',
  'chain.stages.dyeing.desc':
    'Tingimento reativo e acabamento. O último relatório de águas residuais ultrapassa a janela de doze meses, pelo que a etapa está assinalada para revisão.',

  'chain.stages.cutting.name': 'Corte',
  'chain.stages.cutting.supplier': 'Atelier Milano — Corte',
  'chain.stages.cutting.country': 'Itália',
  'chain.stages.cutting.facility': 'Sala de corte de Milão',
  'chain.stages.cutting.document': 'Registo de produção',
  'chain.stages.cutting.dossierName': 'Atelier Milano — Corte',
  'chain.stages.cutting.desc':
    'Corte automatizado com recuperação de retalhos, que alimenta o fluxo de conteúdo reciclado declarado no passaporte.',

  'chain.stages.assembly.name': 'Confeção',
  'chain.stages.assembly.country': 'Itália',
  'chain.stages.assembly.facility': 'Unidade de confeção de Milão',
  'chain.stages.assembly.document': 'Relatório de auditoria social',
  'chain.stages.assembly.desc':
    'Fabricante de Tier 1. As auditorias sociais e de qualidade estão em dia, a taxa de submissão é elevada e há duas questões em remediação.',

  'chain.stages.product.name': 'Produto',
  'chain.stages.product.tier': 'Marca',
  'chain.stages.product.country': 'França',
  'chain.stages.product.facility': 'Estúdio de design de Paris',
  'chain.stages.product.certificate': 'Núcleo de dados de produto 1.0',
  'chain.stages.product.document': 'Ficha de dados do produto',
  'chain.stages.product.dossierName': 'T-shirt de algodão biológico · AW26-0248',
  'chain.stages.product.desc':
    'A referência acabada. Composição, identificadores, cadeia de fornecimento e provas consolidados num único registo de produto auditável.',

  'chain.stages.dpp.tier': 'Passaporte',
  'chain.stages.dpp.country': 'União Europeia',
  'chain.stages.dpp.facility': 'Ponto de acesso público do passaporte',
  'chain.stages.dpp.document': 'Registo do passaporte',
  'chain.stages.dpp.dossierName': 'Passaporte Digital do Produto',
  'chain.stages.dpp.desc':
    'Indicador de preparação para publicação. Identidade, composição, materiais, fornecedores e dados de fabrico estão completos; faltam dois elementos de prova.',

  'pi.demoBanner': 'Registo de demonstração — todos os valores desta página são dados de demonstração.',
  'pi.console': 'inteligência de produto',
  'pi.demoUser': 'Espaço de demonstração',
  'pi.nav.main': 'Consola principal',
  'pi.nav.overview': 'Vista geral',
  'pi.nav.products': 'Produtos',
  'pi.nav.suppliers': 'Fornecedores',
  'pi.nav.materials': 'Materiais',
  'pi.nav.supplyChain': 'Cadeia de fornecimento',
  'pi.nav.collection': 'Recolha e conformidade',
  'pi.nav.dataCollection': 'Recolha de dados',
  'pi.nav.evidence': 'Provas',
  'pi.nav.certifications': 'Certificações',
  'pi.nav.quality': 'Qualidade',
  'pi.nav.risk': 'Risco',
  'pi.nav.governance': 'Governação',
  'pi.nav.reports': 'Relatórios',
  'pi.nav.settings': 'Definições',

  'pi.product.name': 'T-shirt de algodão biológico',
  'pi.product.collection': 'Outono / Inverno 2026',
  'pi.product.lead':
    'Cada valor abaixo tem um nível de prova. Nada é afirmado sem um documento por trás.',
  'pi.actions.viewPassport': 'Ver passaporte público',
  'pi.actions.requestData': 'Pedir dados',

  'pi.sections.signals': 'Sinais do produto',
  'pi.sections.identity': 'Identidade',
  'pi.sections.timeline': 'Atividade recente',
  'pi.sections.composition': 'Composição',
  'pi.sections.materials': 'Materiais',
  'pi.sections.lineage': 'Linhagem do produto',
  'pi.sections.manufacturing': 'Fabrico',
  'pi.sections.suppliers': 'Fornecedores',
  'pi.sections.evidence': 'Provas',
  'pi.sections.certifications': 'Certificações',
  'pi.sections.quality': 'Qualidade dos dados',
  'pi.sections.issues': 'Questões em aberto',
  'pi.sections.dpp': 'Preparação DPP',
  'pi.sections.history': 'Histórico completo',

  'pi.metrics.quality': 'Qualidade dos dados',
  'pi.metrics.evidence': 'Cobertura de provas',
  'pi.metrics.traceability': 'Rastreabilidade',
  'pi.metrics.dpp': 'Preparação DPP',

  'pi.tabs.overview': 'Vista geral',
  'pi.tabs.composition': 'Composição',
  'pi.tabs.materials': 'Materiais',
  'pi.tabs.supplyChain': 'Cadeia de fornecimento',
  'pi.tabs.manufacturing': 'Fabrico',
  'pi.tabs.suppliers': 'Fornecedores',
  'pi.tabs.evidence': 'Provas',
  'pi.tabs.certifications': 'Certificações',
  'pi.tabs.quality': 'Qualidade',
  'pi.tabs.history': 'Histórico',

  'pi.trust.missing': 'Em falta',
  'pi.trust.review': 'A rever',
  'pi.trust.declared': 'Declarado',
  'pi.trust.documented': 'Documentado',
  'pi.trust.verified': 'Verificado',
  'pi.trust.certified': 'Certificado',

  'pi.labels.reference': 'Referência',
  'pi.labels.category': 'Categoria',
  'pi.labels.collection': 'Coleção',
  'pi.labels.madeIn': 'Fabricado em',
  'pi.labels.status': 'Estado',
  'pi.labels.material': 'Material',
  'pi.labels.share': 'Proporção',
  'pi.labels.standard': 'Norma',
  'pi.labels.proof': 'Prova',
  'pi.labels.type': 'Tipo',
  'pi.labels.supplier': 'Fornecedor',
  'pi.labels.origin': 'Origem',
  'pi.labels.step': 'Etapa',
  'pi.labels.facility': 'Unidade',
  'pi.labels.country': 'País',
  'pi.labels.dataQuality': 'Qualidade dos dados',
  'pi.labels.certificates': 'Certificados',
  'pi.labels.document': 'Documento',
  'pi.labels.issuer': 'Emissor',
  'pi.labels.issued': 'Emitido',
  'pi.labels.expires': 'Expira',
  'pi.labels.verification': 'Verificação',
  'pi.labels.certificate': 'Certificado',
  'pi.labels.scope': 'Âmbito',
  'pi.labels.holder': 'Titular',
  'pi.labels.fix': 'Corrigir',

  'pi.values.category': 'Malha jersey — manga curta',
  'pi.values.collection': 'Outono / Inverno 2026',
  'pi.values.madeIn': 'Itália',
  'pi.values.status': 'Ativo — publicação pendente',

  'pi.fibers.organicCotton': 'Algodão biológico',
  'pi.fibers.recycledElastane': 'Elastano reciclado',
  'pi.fibers.sewingThread': 'Linha de costura',
  'pi.types.yarn': 'Fio',
  'pi.types.fabric': 'Tecido',
  'pi.types.chemical': 'Químico',
  'pi.types.trim': 'Acessório',
  'pi.steps.spinning': 'Fiação',
  'pi.steps.knitting': 'Tricotagem',
  'pi.steps.dyeing': 'Tingimento',
  'pi.steps.cutting': 'Corte',
  'pi.steps.assembly': 'Confeção',
  'pi.steps.finishing': 'Acabamento',

  'pi.lineage.nodes.fiber': 'Fibra',
  'pi.lineage.nodes.spinner': 'Fiação',
  'pi.lineage.nodes.yarn': 'Fio',
  'pi.lineage.nodes.fabric': 'Tecido',
  'pi.lineage.nodes.dyehouse': 'Tinturaria',
  'pi.lineage.nodes.manufacturer': 'Fabricante',
  'pi.lineage.nodes.product': 'Produto acabado',
  'pi.lineage.detail.fiber':
    'Algodão biológico em bruto com certificados de transação por lote, reconciliados com o balanço de massa.',
  'pi.lineage.detail.spinner':
    'Fiação a anéis de fio biológico penteado. Falta ainda a verificação por terceiros em dois títulos.',
  'pi.lineage.detail.yarn':
    'Lotes de fio ligados à lista de materiais do produto, com registos completos de cadeia de custódia.',
  'pi.lineage.detail.fabric':
    'Malha jersey simples com tratamento de água em circuito fechado na unidade de Guimarães.',
  'pi.lineage.detail.dyehouse':
    'Tingimento reativo e acabamento. O último relatório de águas residuais está fora da janela de doze meses.',
  'pi.lineage.detail.manufacturer':
    'Confeção de Tier 1. Auditorias sociais e de qualidade em dia, duas constatações em curso.',
  'pi.lineage.detail.product':
    'O artigo acabado. Composição, identificadores, cadeia e provas consolidados.',
  'pi.lineage.detail.dpp':
    'Indicador de preparação para publicação. Faltam ainda dois elementos de prova.',

  'pi.docs.transactionCert': 'Certificado de transação',
  'pi.docs.labReport': 'Relatório de ensaio laboratorial',
  'pi.docs.socialAudit': 'Relatório de auditoria social',
  'pi.docs.wastewater': 'Análise de águas residuais',
  'pi.docs.productionRecord': 'Registo de produção',
  'pi.docs.materialDeclaration': 'Declaração de material',

  'pi.scopes.scopeFiberFabric': 'Da fibra ao tecido',
  'pi.scopes.scopeRecycled': 'Conteúdo reciclado',
  'pi.scopes.scopeChemical': 'Segurança química',
  'pi.scopes.scopeSocial': 'Conformidade social',
  'pi.scopes.scopeWastewater': 'Descarga de águas residuais',

  'pi.quality.completeness': 'Completude',
  'pi.quality.evidenceCoverage': 'Cobertura de provas',
  'pi.quality.verificationRate': 'Taxa de verificação',
  'pi.quality.supplyChainDepth': 'Profundidade da cadeia',

  'pi.issues.issueWastewater.t': 'Análise de águas residuais desatualizada',
  'pi.issues.issueWastewater.d': 'Tinturaria Adriática — o último relatório ultrapassa a janela de doze meses',
  'pi.issues.issueOekoTex.t': 'Certificado OEKO-TEX a expirar',
  'pi.issues.issueOekoTex.d': 'Fiação de Guimarães — válido por menos de 90 dias',
  'pi.issues.issueSpinnerVerify.t': 'Dados da fiação a aguardar verificação',
  'pi.issues.issueSpinnerVerify.d': 'Dois títulos de fio declarados mas não verificados por terceiros',

  'pi.dpp.title': 'Preparação do Passaporte Digital do Produto',
  'pi.dpp.lead': 'O que este produto poderia publicar hoje e o que ainda falta para o poder fazer.',
  'pi.dpp.legal': 'Um indicador de preparação, nunca uma certificação legal.',
  'pi.dpp.score': 'Preparação',
  'pi.dpp.ready': 'Pronto a publicar',
  'pi.dpp.missing': 'O que está em falta?',
  'pi.dpp.items.dppIdentity': 'Identidade e identificadores do produto',
  'pi.dpp.items.dppComposition': 'Composição resolvida ao nível da percentagem',
  'pi.dpp.items.dppMaterials': 'Materiais e respetiva origem',
  'pi.dpp.items.dppSuppliers': 'Fornecedores em quatro níveis',
  'pi.dpp.items.dppManufacturing': 'Etapas de fabrico e unidades',
  'pi.dpp.items.dppCare': 'Instruções de conservação e manutenção',
  'pi.dpp.items.dppCircularity': 'Circularidade e conteúdo reciclado',
  'pi.dpp.items.dppGapWastewater': 'Análise de águas residuais atualizada para a tinturaria',
  'pi.dpp.items.dppGapRepair': 'Informação sobre reparação e peças de substituição',

  'pi.history.hDppRecomputed': 'Preparação DPP recalculada — 88 %',
  'pi.history.hProductionRecord': 'Registo de produção anexado pelo Atelier Milano',
  'pi.history.hDyeFlagged': 'Tinturaria assinalada para revisão — relatório de águas residuais expirado',
  'pi.history.hLabReport': 'Relatório de ensaio laboratorial verificado pela Intertek',
  'pi.history.hComposition': 'Declaração de composição resolvida ao nível da percentagem',
  'pi.history.hGotsLinked': 'Certificado de transação GOTS 6.0 associado',
  'pi.history.hSocialAudit': 'Auditoria social SA8000 aceite',
  'pi.history.hCreated': 'Produto criado no espaço de trabalho',

  'pi.notes.composition':
    'As percentagens são resolvidas com base na lista de materiais e reconciliadas com os certificados de transação da fibra.',
  'pi.notes.lineage':
    'Selecione uma etapa para inspecionar a organização por trás dela. Cada passo tem o seu próprio nível de prova.',
  'pi.notes.evidence':
    'Cada documento é guardado com o seu emissor, âmbito, período de validade e um selo de integridade SHA-256.',
  'pi.notes.issues': 'Cada questão remete para o ecrã que a resolve',
  'pi.notes.otherRef': 'Referência pedida {ref} — a mostrar o registo de demonstração.',
};

// --- Construction recursive, structure identique a EN -----------------------
const untouched = [];
function build(src, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const path = prefix + k;
    if (v && typeof v === 'object') out[k] = build(v, path + '.');
    else if (Object.prototype.hasOwnProperty.call(PT, path)) out[k] = PT[path];
    else {
      out[k] = v;
      untouched.push([path, v]);
    }
  }
  return out;
}

const pt = build(EN);
// lang.pt doit exister dans toutes les locales pour le menu de langue
pt.lang = pt.lang || {};
pt.lang.pt = 'Português';

writeFileSync(
  new URL('../assets/i18n/pt.json', import.meta.url),
  JSON.stringify(pt, null, 1) + '\n',
  'utf8',
);

const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));

console.log(`pt.json ecrit — ${flat(pt).length} cles`);
console.log(`traduites : ${flat(pt).length - untouched.length}`);
console.log(`conservees en l'etat : ${untouched.length}`);
for (const [k, v] of untouched) console.log(`   ${k.padEnd(42)} ${v}`);
