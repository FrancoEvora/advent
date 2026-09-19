import Image from "next/image";
import type { ReactNode } from "react";
import { SolarisCaptureForm } from "./SolarisCaptureForm";
import { SolarisBookLink } from "./SolarisBookLink";
import { SolarisPartners } from "./SolarisPartners";
import base from "./solaris-form.module.css";
import s from "./solaris-magazine.module.css";

const BOOK = "/forms/solaris/book";
const PHOTOS = "/forms/solaris/editorial";
const amenities = [
  { title: "Natureza & caminhos", text: "Sair para caminhar, fazer uma pausa à sombra e incluir o verde no dia a dia.", items: ["Bosques, trilhas e ciclovias", "Lago ornamental e areal", "Deck e setor de pesca"] },
  { title: "Água & encontros", text: "Espaços para aproveitar o fim de semana, receber os amigos e celebrar em família.", items: ["Piscinas adulto e infantil", "Casa Évora e espaço gourmet", "Restaurante e espaço de eventos"] },
  { title: "Esporte & movimento", text: "Uma partida depois do trabalho ou uma atividade para compartilhar com os filhos.", items: ["Quadras de tênis e beach tennis", "Campo de futebol society", "Quadra poliesportiva"] },
  { title: "Cuidado & bem-estar", text: "Ambientes previstos para cuidar do corpo e reservar um tempo para você.", items: ["Academia profissional", "Spa e sauna", "Acessibilidade na proposta do projeto"] },
  { title: "Infância & convivência", text: "Crianças e pets também fazem parte de uma casa que se estende para o lado de fora.", items: ["Brinquedoteca e espaços infantis", "Dog park / pet place", "Áreas de convivência ao ar livre"] },
  { title: "Centro Hípico", text: "Anexo ao Solaris, o Centro Hípico aproxima a vida equestre da proposta de morar perto da natureza.", items: ["Centro Hípico anexo ao Solaris", "Convivência e contato com os animais", "Consulte as atividades e as condições de acesso"] },
];

function Brand() {
  return <span className={s.brand}><Image src={`${BOOK}/simbolo.avif`} width={48} height={50} alt="" unoptimized /><span>SOLARIS<small>RESIDENCIAL RESORT</small></span></span>;
}

function Photo({ name, alt, width, height, className, children, eager = false }: {
  name: string; alt: string; width: number; height: number; className?: string; children?: ReactNode; eager?: boolean;
}) {
  return <figure className={`${s.photo} ${className || ""}`}>
    <Image src={`${PHOTOS}/${name}.webp`} alt={alt} width={width} height={height} unoptimized loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : undefined} />
    {children && <figcaption>{children}</figcaption>}
  </figure>;
}

function SectionLabel({ number, children }: { number: string; children: ReactNode }) {
  return <div className={s.sectionLabel}><span>{number}</span><p>{children}</p><span>SOLARIS / MONTE CARMELO</span></div>;
}

export function SolarisMagazine() {
  return <main className={`${base.shell} ${s.page}`} id="conteudo-principal" data-solaris-version="revista-v3">
    <a className={base.skip} href="#formulario">Ir para o formulário</a>
    <div className={s.topline}><span>MONTE CARMELO · MINAS GERAIS</span><span>NATUREZA, CONVIVÊNCIA E UM NOVO JEITO DE MORAR</span></div>
    <header className={s.header}>
      <a href="#inicio" aria-label="Solaris — início"><Brand /></a>
      <nav aria-label="Nesta edição"><a href="#vizinhos">A vizinhança</a><a href="#vida-livre">Vida ao ar livre</a><a href="#lazer">O empreendimento</a><a href="#localizacao">Localização</a></nav>
      <a className={s.button} href="#formulario">Conhecer os lotes <span aria-hidden="true">↗</span></a>
    </header>
    <div className={s.edition}><span>SEUS PRÓXIMOS VIZINHOS</span><span>UM CONVITE PARA VIVER DE VERDADE</span></div>

    <section className={s.opening} id="inicio" aria-labelledby="solaris-titulo">
      <div className={s.cover}>
        <Photo name="paisagem-aerea" alt="Vista ampla de vegetação, lagos e caminhos ao fim da tarde." width={1672} height={941} eager />
        <div className={s.coverText}><p>O MELHOR DA VIDA ESTÁ MAIS PERTO DO QUE PARECE.</p><h1 id="solaris-titulo">Uma vida mais simples.<br /><em>Uma vizinhança<br />cheia de vida.</em></h1><p>Natureza, lazer e espaço para construir a sua casa em Monte Carmelo.</p><a href="#vizinhos">Abra espaço para essa história <span aria-hidden="true">↓</span></a></div>
        <span className={s.coverFoot}>SOLARIS RESIDENCIAL RESORT · IMAGEM DO ACERVO DA CAMPANHA</span>
      </div>
      <aside className={s.capture} aria-label="Conheça os lotes do Solaris">
        <div className={s.captureLead}><span>LOTES A PARTIR DE 360 M²</span><p>Gostou da ideia?<br /><strong>Vamos conversar.</strong></p></div>
        <SolarisCaptureForm />
        <div className={s.service}><span>ATENDIMENTO</span><Image src={`${BOOK}/futura-casa-monocromatica-v1.webp`} alt="Futura Casa — Inteligência Imobiliária, Marketing e Vendas" width={720} height={346} unoptimized /></div>
      </aside>
    </section>
    <div className={s.facts} aria-label="O projeto em números"><div><strong>360 m²</strong><span>metragem inicial dos lotes</span></div><div><strong>+300 mil m²</strong><span>de área verde, conforme o book</span></div><div><strong>24 horas</strong><span>de portaria previstas no projeto</span></div><div><strong>Em obras</strong><span>consulte o cronograma de implantação</span></div></div>

    <section className={s.section} id="vizinhos" aria-labelledby="vizinhos-titulo">
      <SectionLabel number="01">SEUS PRÓXIMOS VIZINHOS</SectionLabel>
      <div className={s.birdStory}>
        <Photo name="arara" alt="Arara-canindé em detalhe, com plumagem azul e amarela." width={850} height={1275} className={s.arara}>As cores da vizinhança. Um convite para olhar com mais atenção.</Photo>
        <div className={s.birdCopy}><p className={s.kicker}>ELES INSPIRAM ESSE JEITO DE VIVER.</p><h2 id="vizinhos-titulo">Aqui, a natureza<br />entra na <em>conversa.</em></h2>
          <p className={s.standfirst}>O canto de um pássaro, a sombra de uma árvore, a luz que muda no fim da tarde. A vida também acontece nesses pequenos encontros.</p>
          <div className={s.columns}><p>“Seus próximos vizinhos” é um convite para imaginar uma casa que se conecta ao que existe do lado de fora. Um lugar onde observar as aves e acompanhar o ritmo da paisagem pode fazer parte da rotina.</p><p>É essa proximidade que orienta a proposta do Solaris: combinar o seu espaço de morar com natureza, convivência e lazer. Ter onde construir a casa e também motivos para sair dela, caminhar e encontrar as pessoas.</p></div>
          <div className={s.garcaRow}><Photo name="garca" alt="Garça branca em voo diante da vegetação." width={750} height={1125} /><div><span className={s.kicker}>UM INSTANTE PARA REPARAR</span><h3>Menos pressa.<br />Mais presença.</h3><p>Há uma paisagem inteira para descobrir quando a gente desacelera.</p></div></div>
        </div>
      </div>
    </section>

    <section className={`${s.section} ${s.landscape}`} aria-labelledby="paisagem-titulo">
      <SectionLabel number="02">O PRIVILÉGIO DAS COISAS SIMPLES</SectionLabel>
      <div className={s.landscapeGrid}><div><p className={s.kicker}>UMA ROTINA QUE RESPIRA</p><h2 id="paisagem-titulo">Mais espaço<br />para o que<br /><em>faz bem.</em></h2><p className={s.dropcap}>Nem todo momento precisa de um grande programa. Uma caminhada, uma conversa demorada, os filhos descobrindo uma ave diferente. É de experiências assim que se constrói uma vida com mais presença.</p><p>No Solaris, a proposta de bosques, trilhas, ciclovias e espaços junto à água aproxima o lazer do cotidiano. A natureza acompanha a ideia de morar, conviver e cuidar de si.</p><blockquote>Um lugar para construir a casa.<br />E cultivar a vida ao redor.</blockquote><a className={s.textLink} href="#formulario">Conhecer os lotes →</a></div><Photo name="lago" alt="Árvores e uma palmeira refletidas na água de um lago." width={900} height={1349}>A paisagem como companhia. Imagem do acervo da campanha.</Photo></div>
    </section>

    <section className={s.section} id="vida-livre" aria-labelledby="vida-titulo">
      <SectionLabel number="03">HISTÓRIAS DO LADO DE FORA</SectionLabel>
      <div className={s.storyHeading}><h2 id="vida-titulo">O tempo junto<br /><em>vira memória.</em></h2><p>Compartilhar um passeio, conhecer caminhos, estar perto dos animais. A vida ao ar livre aproxima gerações e abre espaço para experiências que ficam.</p></div>
      <div className={s.outdoorGrid}>
        <Photo name="trilha" alt="Grupo com capacetes em passeio de quadriciclo por um caminho arborizado." width={1400} height={934} className={s.trilha}>01 / Descobrir caminhos. Cena de passeio do acervo; quadriciclos não integram a oferta de equipamentos aqui apresentada.</Photo>
        <Photo name="leo-chaves-embaixador" alt="Leo Chaves, embaixador do Solaris." width={1000} height={1500} className={s.ambassador}><strong>Leo Chaves</strong><span>Embaixador do Solaris</span></Photo>
        <article className={s.hipica} id="centro-hipico" aria-labelledby="hipica-titulo">
          <p className={s.kicker}>CAVALOS, NATUREZA E CONVIVÊNCIA</p>
          <h3 id="hipica-titulo">Centro Hípico<br /><em>anexo ao Solaris.</em></h3>
          <p>Um espaço dedicado à vida equestre, anexo ao Solaris. A proximidade com os cavalos traz outra possibilidade de convivência e de experiências ao ar livre para a vizinhança.</p>
          <p>Conheça a proposta do Centro Hípico e converse com a equipe sobre as atividades, o funcionamento e as condições de acesso.</p>
        </article>
        <div className={s.equestrianGallery} aria-label="Imagens de referência da vida equestre">
          <Photo name="centro-hipico-pista" alt="Praticantes de equitação em uma pista de terra com cavalos e tambores." width={842} height={562}>02 / Movimento e contato com os cavalos. Imagem de referência.</Photo>
          <Photo name="centro-hipico-cavalo" alt="Criança sorrindo montada em um cavalo em uma área de equitação." width={842} height={562}>03 / Uma experiência que aproxima gerações. Imagem de referência.</Photo>
        </div>
      </div>
    </section>

    <section className={`${s.section} ${s.amenities}`} id="lazer" aria-labelledby="lazer-titulo">
      <SectionLabel number="04">POR DENTRO DO EMPREENDIMENTO</SectionLabel>
      <div className={s.storyHeading}><h2 id="lazer-titulo">O que faz parte<br /><em>do projeto Solaris.</em></h2><div><p>Natureza é o ponto de partida. O lazer, os espaços de convivência e a estrutura planejada completam a proposta para o dia a dia.</p><span className={s.projectTag}>ITENS PREVISTOS EM PROJETO · OBRAS EM ANDAMENTO</span></div></div>
      <div className={s.amenityGrid}>{amenities.map((item, index) => <article key={item.title}><span className={s.itemNumber}>0{index + 1}</span><h3>{item.title}</h3><p>{item.text}</p><ul>{item.items.map(text => <li key={text}>{text}</li>)}</ul></article>)}</div>
      <details className={s.projectImages}><summary>Veja as perspectivas de alguns espaços do projeto <span aria-hidden="true">＋</span></summary><div>{[{file:"resort",title:"Piscinas e Casa Évora",w:1200,h:837},{file:"tenis",title:"Tênis e beach tennis",w:700,h:514},{file:"familia",title:"Brinquedoteca e pet place",w:700,h:427}].map(item => <figure key={item.file}><Image src={`${BOOK}/${item.file}.avif`} alt={`Perspectiva ilustrativa: ${item.title}.`} width={item.w} height={item.h} unoptimized loading="lazy" /><figcaption>{item.title} · Perspectiva ilustrativa do book.</figcaption></figure>)}</div></details>
      <div className={s.bookLine}><p>Todos os espaços, com mais detalhes.<small>Confira o memorial descritivo e o cronograma aplicável à sua proposta.</small></p><SolarisBookLink className={s.button}>Baixar book comercial (PDF)</SolarisBookLink></div>
    </section>

    <section className={s.section} id="lotes" aria-labelledby="lotes-titulo"><SectionLabel number="05">BASE PARA O SEU PRÓXIMO CAPÍTULO</SectionLabel><div className={s.projectGrid}><div><p className={s.kicker}>LOTES · ESTRUTURA · PLANEJAMENTO</p><h2 id="lotes-titulo">Antes da casa,<br /><em>uma boa escolha.</em></h2><p className={s.standfirst}>Conhecer um lote é pensar na casa, mas também no entorno, nos acessos e na rotina que você deseja construir.</p><a className={s.textLink} href="#formulario">Receber lotes e condições →</a></div><div className={s.specs}><article><span>01</span><div><h3>Lotes a partir de 360 m²</h3><p>Consulte a disponibilidade, as metragens e a posição de cada unidade. A escolha do lote pode ser orientada pelo seu objetivo de morar ou investir.</p></div></article><article><span>02</span><div><h3>Controle de acesso e segurança</h3><p>O book prevê portaria 24 horas, controle de acesso, biometria, reconhecimento facial e monitoramento por câmeras e drones. Confirme os itens e as etapas no memorial.</p></div></article><article><span>03</span><div><h3>Financiamento com a loteadora</h3><p>Receba as condições comerciais vigentes. Entrada, parcelas, juros, correções e prazos são definidos na proposta.</p></div></article><article><span>04</span><div><h3>Obras em andamento</h3><p>A implantação acontece por etapas. Solicite informações atualizadas sobre as obras e confira os prazos e as entregas previstos no contrato.</p></div></article></div></div></section>

    <section className={`${s.section} ${s.location}`} id="localizacao" aria-labelledby="local-titulo"><SectionLabel number="06">O ENDEREÇO DESSA HISTÓRIA</SectionLabel><div className={s.locationGrid}><div><p className={s.kicker}>MONTE CARMELO · MINAS GERAIS</p><h2 id="local-titulo">No Parque<br /><em>das Árvores.</em></h2><p>O Solaris integra a proposta do bairro Parque das Árvores, em Monte Carmelo. Uma escolha para quem quer aproximar o seu projeto de casa de espaços de natureza e convivência.</p><p>A equipe pode apresentar os acessos, a localização dos lotes e os pontos de referência indicados no material comercial.</p><a className={s.textLink} href="#formulario">Conhecer a localização →</a></div><figure className={s.map}><Image src={`${BOOK}/parque-das-arvores-setores.avif`} alt="Mapa ilustrativo do Parque das Árvores com identificação dos setores e do Solaris." width={1024} height={683} unoptimized loading="lazy" /><figcaption>Perspectiva ilustrativa do bairro; não representa o estágio atual das obras.<a href={`${BOOK}/parque-das-arvores-setores.avif`} target="_blank" rel="noopener noreferrer">Ampliar mapa ↗</a></figcaption></figure></div></section>

    <section className={s.section} aria-labelledby="tempo-titulo"><SectionLabel number="07">UM ÁLBUM DE PEQUENOS MOMENTOS</SectionLabel><div className={s.storyHeading}><h2 id="tempo-titulo">O dia muda.<br /><em>O que importa fica.</em></h2><p>Do primeiro sol ao fim da tarde, a paisagem ganha outras cores. Um lembrete de que viver bem também é encontrar tempo para perceber.</p></div><div className={s.album}><Photo name="amanhecer" alt="Luz dourada do amanhecer entre árvores e vegetação." width={850} height={1062}>01 / A luz de um novo dia.</Photo><Photo name="entardecer" alt="Sol se pondo no horizonte de um caminho de terra." width={1400} height={788}>02 / O caminho de volta.</Photo><Photo name="arvore" alt="Silhueta de uma árvore diante do sol ao entardecer." width={750} height={1125}>03 / Uma pausa antes de amanhã.</Photo></div><p className={s.imageNote}>Imagens do acervo da campanha, utilizadas para apresentar a proposta de vida ao ar livre.</p></section>

    <section className={`${s.section} ${s.faq}`} aria-labelledby="duvidas-titulo"><div><p className={s.kicker}>PARA CONHECER COM CLAREZA</p><h2 id="duvidas-titulo">Suas perguntas.<br /><em>Nosso próximo encontro.</em></h2></div><div><details><summary>O Solaris já está pronto para morar?</summary><p>O empreendimento está em obras. Os equipamentos de lazer e a estrutura são apresentados como previstos em projeto. Confirme o estágio atual e o cronograma de entrega com a equipe.</p></details><details><summary>Como consultar valores e disponibilidade?</summary><p>Preencha o formulário no início da página. A equipe da Futura Casa entra em contato pelo WhatsApp para apresentar lotes e condições atualizadas.</p></details><details><summary>As imagens são de estruturas já entregues?</summary><p>As imagens do acervo ilustram natureza e vida ao ar livre. Os desenhos de equipamentos e do bairro estão identificados como perspectivas ilustrativas. Nenhuma dessas imagens substitui a informação sobre o estágio das obras.</p></details><details><summary>O cadastro já reserva um lote?</summary><p>Não. Ele registra seu interesse para atendimento, sem compromisso de compra. Reserva, disponibilidade e contratação são tratados em uma etapa comercial específica.</p></details></div></section>
    <section className={s.finalCta}><p className={s.kicker}>SEUS PRÓXIMOS VIZINHOS</p><h2>Agora só falta <em>você.</em></h2><p>Conheça os lotes, converse sobre as condições e imagine seu próximo capítulo no Solaris.</p><a className={s.button} href="#formulario">Quero conhecer o Solaris →</a></section>
    <SolarisPartners />
    <footer className={s.footer}><Brand /><p>Solaris Residencial Resort · Monte Carmelo, Minas Gerais.</p><p>Conteúdo do empreendimento baseado no Book Comercial Solaris 2026 V6. Consulte o memorial descritivo, a documentação contratual, o cronograma e a disponibilidade. Imagens do acervo da campanha; perspectivas de projeto identificadas. As cenas de passeios não implicam oferta de equipamentos, atividades ou serviços além dos descritos na documentação comercial.</p><a href="/privacidade">Privacidade e uso dos dados</a></footer>
  </main>;
}
