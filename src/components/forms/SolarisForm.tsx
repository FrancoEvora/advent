"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import Image from "next/image";
import { SolarisCaptureForm } from "./SolarisCaptureForm";
import { SolarisAmbassador } from "./SolarisAmbassador";
import { SolarisBookLink } from "./SolarisBookLink";
import { SolarisPartners } from "./SolarisPartners";
import styles from "./solaris-form.module.css";
import updates from "./solaris-updates.module.css";
import downloads from "./solaris-downloads.module.css";

const ASSETS = "/forms/solaris/book";
const experiences = [
  { id: "resort", tab: "Lazer resort", number: "01", title: "O lazer encontra um novo endereço.", description: "Complexo aquático, Casa Évora e espaços para celebrar. Uma proposta que une lazer, convivência e a experiência de morar bem.", items: ["Piscinas adulto e infantil", "Casa Évora e espaço gourmet", "Restaurante e espaço de eventos"], image: "resort", width: 1200, height: 837, page: "6, 8, 14 e 16", alt: "Perspectiva ilustrativa do complexo aquático e da Casa Évora apresentada no book Solaris." },
  { id: "natureza", tab: "Natureza", number: "02", title: "Viver cercado de natureza, todos os dias.", description: "Bosques, ciclovias, trilhas e um lago ornamental. Espaços pensados para caminhar, contemplar e transformar a natureza em parte da rotina.", items: ["Bosques e trilhas sombreadas", "Lago ornamental e areal", "Deck e setor de pesca"], image: "natureza", width: 600, height: 622, page: "7, 11 e 18", alt: "Perspectiva ilustrativa de uma trilha em meio aos bosques do Solaris, extraída do book." },
  { id: "bem-estar", tab: "Bem-estar", number: "03", title: "Corpo, mente e equilíbrio.", description: "A Casa Évora reúne a proposta de uma academia profissional e ambientes de spa e sauna, com arquitetura integrada à natureza.", items: ["Academia profissional", "Spa e sauna", "Design biofílico e acessibilidade"], image: "academia", width: 700, height: 484, page: "8 e 13", alt: "Perspectiva ilustrativa da academia da Casa Évora, com vista para o paisagismo." },
  { id: "esportes", tab: "Esportes", number: "04", title: "Mais movimento. Mais vida ao ar livre.", description: "Do tênis ao beach tennis, do futebol aos encontros com os amigos: espaços para uma rotina ativa e momentos de convivência.", items: ["Quadras de tênis e beach tennis", "Campo de futebol society", "Quadra poliesportiva"], image: "tenis", width: 700, height: 514, page: "15, 17 e 21", alt: "Perspectiva ilustrativa das quadras de tênis e beach tennis do Solaris." },
  { id: "familia", tab: "Família", number: "05", title: "Um lugar pensado para toda a família.", description: "Crianças e pets também têm seu espaço. A proposta do Solaris reúne ambientes para brincar, caminhar e compartilhar momentos juntos.", items: ["Brinquedoteca e espaços infantis", "Dog park / pet place", "Caminhadas ao ar livre"], image: "familia", width: 700, height: 427, page: "9 e 21", alt: "Ilustração do book Solaris com brinquedoteca e dog park, espaços previstos para crianças e pets." },
  { id: "hipica", tab: "Hípica", number: "06", title: "A natureza ganha movimento e liberdade.", description: "A hípica foi idealizada para aproximar a família da vida ao ar livre, dos animais e da tradição equestre, em um ambiente integrado à paisagem.", items: ["Conexão com os animais", "Experiências ao ar livre", "Tradição equestre"], image: "hipica", width: 650, height: 749, page: "12", alt: "Perspectiva ilustrativa da hípica planejada para o Solaris, extraída do book comercial." },
];
const safetyItems = ["Portaria 24 horas", "Controle de acesso", "Biometria e reconhecimento facial", "Monitoramento por câmeras e drones"];

function Brand({ small = false }: { small?: boolean }) {
  return <span className={`${styles.brand} ${small ? styles.brandSmall : ""}`}>
    <Image className={styles.brandMark} src={`${ASSETS}/simbolo.avif`} alt="" width={52} height={54} unoptimized />
    <span className={styles.brandWords}><span>Solaris</span><small>RESIDENCIAL RESORT</small></span>
  </span>;
}

export function SolarisForm() {
  const [active, setActive] = useState(0);
  const [registered, setRegistered] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const selected = experiences[active];

  useEffect(() => {
    const form = document.getElementById("formulario");
    if (!form || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => setFormVisible(entry.isIntersecting), { threshold: 0.12 });
    observer.observe(form);
    return () => observer.disconnect();
  }, []);

  function switchTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % experiences.length;
    else if (event.key === "ArrowLeft") next = (index + experiences.length - 1) % experiences.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = experiences.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    document.getElementById(`tab-${experiences[next].id}`)?.focus();
  }

  return (
    <main className={styles.shell} id="conteudo-principal" data-solaris-version="book-v6" data-solaris-revision="parque-embaixador" data-solaris-downloads="book-v6">
      <a className={styles.skip} href="#formulario">Ir para o formulário</a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.brandLink} href="#inicio" aria-label="Solaris Residencial Resort — início"><Brand /></a>
          <nav className={styles.nav} aria-label="Conheça o Solaris"><a href="#essencia">O Solaris</a><a href="#experiencias">Lazer e natureza</a><a href="#localizacao">Localização</a></nav>
          <a className={styles.headerCta} href="#formulario">Conhecer lotes <span aria-hidden="true">↗</span></a>
        </div>
      </header>
      <section className={styles.hero} id="inicio" aria-labelledby="solaris-titulo">
        <div className={styles.heroImage}>
          <Image src={`${ASSETS}/resort.avif`} alt="Perspectiva ilustrativa do lazer resort do Solaris, com piscinas e Casa Évora ao entardecer." fill sizes="100vw" unoptimized loading="eager" fetchPriority="high" />
        </div>
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <p className={styles.heroEyebrow}><span aria-hidden="true">◉</span> MONTE CARMELO · MINAS GERAIS</p>
            <h1 id="solaris-titulo">Mais natureza.<br />Mais lazer.<br /><em>Mais vida.</em></h1>
            <p className={styles.heroDescription}>Segurança, tranquilidade e conforto para toda a sua família. Um novo jeito de viver no coração do Parque das Árvores.</p>
            <div className={styles.heroLinks}><a className={styles.goldButton} href="#formulario">Quero conhecer o Solaris <span aria-hidden="true">→</span></a><a className={styles.heroExplore} href="#experiencias">Explore o residencial <span aria-hidden="true">↓</span></a></div>
            <p className={styles.heroFine}>Lotes a partir de 360 m² · Perspectiva ilustrativa do projeto</p>
          </div>
          <SolarisCaptureForm onRegistered={() => setRegistered(true)} />
        </div>
      </section>
      <section className={styles.facts} aria-label="Diferenciais do empreendimento">
        <div><span>LOTES A PARTIR DE</span><strong>360 <small>m²</small></strong><p>Espaço para o seu próximo capítulo</p></div>
        <div><span>NATUREZA E BEM-ESTAR</span><strong>+300 mil <small>m²</small></strong><p>De área verde, conforme o book</p></div>
        <div><span>SEGURANÇA PLANEJADA</span><strong>24 <small>horas</small></strong><p>Portaria e controle de acesso previstos</p></div>
        <div><span>SEU CAMINHO ATÉ O LOTE</span><strong className={styles.factWords}>Financiamento<br />com a loteadora</strong><p>Consulte as condições comerciais</p></div>
      </section>
      <section className={`${styles.section} ${styles.essence}`} id="essencia" aria-labelledby="essencia-titulo">
        <div className={styles.essenceCopy}>
          <p className={styles.eyebrow}>A ESSÊNCIA DO SOLARIS</p>
          <h2 id="essencia-titulo">Um novo jeito<br />de viver <em>bem.</em></h2>
          <span className={styles.goldRule} />
          <p className={styles.largeText}>A vida é feita de momentos simples e verdadeiros.</p>
          <p>Estar perto da família. Ter tempo para caminhar. Sentir a natureza fazer parte de cada dia. No Solaris, bem-estar, natureza e lazer se encontram em um projeto pensado para viver mais perto do que importa.</p>
          <div className={styles.essencePills}><span>Natureza presente</span><span>Arquitetura biofílica</span><span>Vida em família</span></div>
          <a className={styles.textLink} href="#formulario">Encontre o seu lugar <span aria-hidden="true">→</span></a>
        </div>
        <figure className={styles.essenceVisual}>
          <Image src={`${ASSETS}/natureza.avif`} alt="Perspectiva ilustrativa de uma caminhada entre os bosques e trilhas do Solaris." width={600} height={622} sizes="(max-width: 760px) 90vw, 42vw" unoptimized loading="lazy" />
          <div className={styles.natureBadge}><strong>+300 mil m²</strong><span>Para cultivar bem-estar,<br />conexão e momentos que transformam.</span></div>
          <figcaption>Perspectiva ilustrativa · Natureza e bem-estar no projeto</figcaption>
        </figure>
      </section>
      <section className={styles.experiences} id="experiencias" aria-labelledby="experiencias-titulo">
        <div className={styles.sectionInner}>
          <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>LAZER, CONVIVÊNCIA E BEM-ESTAR</p><h2 id="experiencias-titulo">A experiência de um resort.<br /><em>A sensação de estar em casa.</em></h2></div><p>Conheça os espaços previstos no projeto apresentado no book comercial.</p></div>
          <div className={styles.tabs} role="tablist" aria-label="Experiências do Solaris">
            {experiences.map((item, index) => <button type="button" key={item.id} role="tab" id={`tab-${item.id}`} aria-selected={active === index} aria-controls="experiencia-painel" tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={event => switchTab(event, index)}>{item.tab}</button>)}
          </div>
          <div className={styles.experiencePanel} id="experiencia-painel" role="tabpanel" aria-labelledby={`tab-${selected.id}`} tabIndex={0}>
            <figure><Image key={selected.image} src={`${ASSETS}/${selected.image}.avif`} alt={selected.alt} width={selected.width} height={selected.height} sizes="(max-width: 760px) 90vw, 60vw" unoptimized loading="lazy" /><figcaption>Perspectiva ilustrativa · Book comercial, páginas {selected.page}</figcaption></figure>
            <div className={styles.experienceCopy}><span className={styles.experienceNumber}>{selected.number} / 06</span><h3>{selected.title}</h3><p>{selected.description}</p><ul>{selected.items.map(item => <li key={item}>{item}</li>)}</ul><a className={styles.lightLink} href="#formulario">Quero saber mais <span aria-hidden="true">→</span></a></div>
          </div>
          <noscript><p>O projeto também prevê bosques, lago ornamental, pesca, academia, spa, sauna, tênis, beach tennis, futebol society, espaços infantis, pet place e hípica. Solicite mais informações à equipe.</p></noscript>
          <div className={styles.bookAccess}><span>Todos os detalhes, no seu tempo.</span><SolarisBookLink>Baixar book completo (PDF)</SolarisBookLink></div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.security}`} aria-labelledby="seguranca-titulo">
        <figure className={styles.gateVisual}><Image src={`${ASSETS}/portaria.avif`} alt="Perspectiva ilustrativa da portaria do Solaris Residencial Resort apresentada no book." width={1100} height={421} unoptimized loading="lazy" /><figcaption>Portaria · Perspectiva ilustrativa do projeto</figcaption></figure>
        <div className={styles.securityBottom}><div><p className={styles.eyebrow}>SEGURANÇA E TRANQUILIDADE</p><h2 id="seguranca-titulo">Conforto para viver.<br /><em>Tranquilidade para pertencer.</em></h2></div><div><p>O projeto prevê portaria 24 horas e tecnologias de controle e monitoramento para oferecer mais tranquilidade à sua rotina.</p><ul className={styles.securityList}>{safetyItems.map((item, index) => <li key={item}><span aria-hidden="true">0{index + 1}</span>{item}</li>)}</ul></div></div>
      </section>
      <section className={styles.locationSection} id="localizacao" aria-labelledby="localizacao-titulo">
        <div className={`${styles.sectionInner} ${styles.locationGrid}`}>
          <div className={styles.locationCopy}><p className={styles.eyebrow}>LOCALIZAÇÃO PRIVILEGIADA</p><h2 id="localizacao-titulo">No coração do<br /><em>Parque das Árvores.</em></h2><p className={styles.largeText}>Monte Carmelo. Um bairro planejado para o futuro.</p><p>Mobilidade, sustentabilidade, lazer e qualidade de vida em uma proposta integrada. O Solaris faz parte do Parque das Árvores, aproximando natureza, conveniência e a vida na cidade.</p><div className={styles.locationReferences}><span>REFERÊNCIAS DO ENTORNO NO BOOK</span><p>UFU · FUCAMP · Hospital Municipal · Mart Minas</p></div><a className={styles.textLink} href="#formulario">Conhecer a localização e os lotes <span aria-hidden="true">→</span></a></div>
          <figure className={updates.neighborhood}>
            <a href={`${ASSETS}/parque-das-arvores-setores.avif`} target="_blank" rel="noopener" aria-label="Ver imagem dos setores do Parque das Árvores em tamanho ampliado"><Image src={`${ASSETS}/parque-das-arvores-setores.avif`} alt="Perspectiva ilustrativa do Bairro Parque das Árvores com marcadores de localização do Solaris, acesso, praça e setores, conforme a imagem fornecida." width={1024} height={683} unoptimized loading="lazy" /></a>
            <figcaption>Parque das Árvores · Perspectiva ilustrativa com a identificação dos setores</figcaption>
            <a className={updates.mapLink} href={`${ASSETS}/parque-das-arvores-setores.avif`} target="_blank" rel="noopener">Ampliar mapa do bairro <span aria-hidden="true">↗</span></a>
          </figure>
        </div>
      </section>
      <SolarisAmbassador />
      <SolarisPartners />
      <section className={styles.faqSection} aria-labelledby="faq-titulo"><div className={`${styles.sectionInner} ${styles.faqGrid}`}><div><p className={styles.eyebrow}>PARA DAR O PRÓXIMO PASSO</p><h2 id="faq-titulo">Sua nova escolha<br />começa com <em>clareza.</em></h2></div><div className={styles.faqList}>
        <details><summary>Os lotes têm qual tamanho mínimo?</summary><p>O book apresenta lotes a partir de 360 m². A equipe da Futura Casa informa as metragens e unidades disponíveis no momento do atendimento.</p></details>
        <details><summary>Como conhecer os valores e as condições?</summary><p>Cadastre seu nome, WhatsApp e objetivo para receber atendimento sobre os lotes. O book prevê financiamento facilitado com a loteadora; valores, entradas, juros, correções e prazos devem ser confirmados na proposta comercial.</p></details>
        <details><summary>As imagens mostram estruturas já entregues?</summary><p>As imagens do empreendimento são perspectivas ilustrativas do book e dos materiais institucionais. Os espaços são apresentados como previstos em projeto, não como comprovação de execução ou entrega. Confirme o memorial descritivo e o estágio das obras no atendimento.</p></details>
        <details><summary>Qual é o prazo de entrega?</summary><p>O book informa entrega das obras em 24 meses, sem definir aqui a data inicial da contagem nem o cronograma de cada estrutura. Confirme os marcos, o escopo e os prazos aplicáveis na documentação contratual.</p></details>
        <details><summary>O cadastro já reserva um lote?</summary><p>Não. O cadastro registra o seu interesse para atendimento. A disponibilidade, as condições e uma eventual reserva são tratadas com a equipe comercial.</p></details>
      </div></div></section>
      <section className={styles.finalCta} aria-labelledby="proximo-passo-titulo"><div className={styles.sectionInner}><p className={styles.finalEyebrow}>SOLARIS RESIDENCIAL RESORT</p><h2 id="proximo-passo-titulo">O seu novo jeito de viver<br /><em>começa aqui.</em></h2><p>Conheça os lotes e encontre o seu lugar entre natureza, lazer e bem-estar.</p><a className={styles.goldButton} href="#formulario">Receber lotes e condições <span aria-hidden="true">→</span></a><SolarisBookLink className={styles.finalBook}>Baixar book comercial (PDF)</SolarisBookLink></div></section>
      <footer className={styles.footer}>
        <div className={downloads.footerBrands} data-solaris-footer="solaris-futura">
          <div data-footer-brand="solaris"><Brand small /></div>
          <div className={downloads.footerService} data-footer-brand="futura-casa">
            <span>ATENDIMENTO</span>
            <Image src={`${ASSETS}/futura-casa-footer.webp`} alt="Futura Casa — Inteligência Imobiliária, Marketing e Vendas" width={258} height={163} unoptimized loading="lazy" />
          </div>
        </div>
        <div className={styles.disclaimer}><p>Conteúdo baseado no Book Comercial Solaris 2026, versão V6, com imagens institucionais fornecidas para esta página. Perspectivas ilustrativas e estruturas previstas em projeto. Consulte o memorial descritivo, a documentação contratual, o cronograma de implantação e a disponibilidade atual. Não há promessa de rentabilidade ou valorização garantida.</p><span>Solaris Residencial Resort · Monte Carmelo, Minas Gerais</span></div>
      </footer>
      {!registered && <div className={`${styles.mobileCta} ${formVisible ? styles.mobileCtaHidden : ""}`} aria-hidden={formVisible}><div><strong>Solaris</strong><span>Lotes a partir de 360 m²</span></div><a href="#formulario" tabIndex={formVisible ? -1 : 0}>Quero conhecer <span aria-hidden="true">→</span></a></div>}
    </main>
  );
}
