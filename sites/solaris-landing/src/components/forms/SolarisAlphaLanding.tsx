"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { SolarisCaptureForm } from "./SolarisCaptureForm";
import styles from "./solaris-alpha.module.css";

const editorial = "/forms/solaris/editorial";
const book = "/forms/solaris/book";

const gallery = [
  { title: "Bosques, trilhas e caminhadas", category: "Natureza", image: "01_bosques_trilhas_ciclovias.webp", caption: "O verde fazendo parte do caminho." },
  { title: "Lago e áreas de contemplação", category: "Paisagem", image: "02_lago_ornamental_areal.webp", caption: "Pausas que renovam todos os dias." },
  { title: "Deck da represa", category: "Natureza", image: "03_deck_represa_pesca.webp", caption: "Um encontro com a água e o horizonte." },
  { title: "Piscinas para a família", category: "Água e lazer", image: "04_piscinas_adulto_infantil.webp", caption: "Dias de sol com tempo para aproveitar." },
  { title: "Casa Évora e espaço gourmet", category: "Convivência", image: "05_casa_evora_gourmet.webp", caption: "Um novo lugar para reunir quem importa." },
  { title: "Restaurante e eventos", category: "Convivência", image: "06_restaurante_eventos.webp", caption: "Celebrar a vida em boa companhia." },
  { title: "Tênis e beach tennis", category: "Esporte", image: "07_tenis_beach_tennis.webp", caption: "Movimento e encontros na medida certa." },
  { title: "Campo de futebol", category: "Esporte", image: "08_futebol_society.webp", caption: "Mais oportunidades para jogar junto." },
  { title: "Quadra poliesportiva", category: "Esporte", image: "09_quadra_poliesportiva.webp", caption: "Esporte para diferentes gerações." },
  { title: "Academia", category: "Bem-estar", image: "10_academia.webp", caption: "Cuidar de si fica mais natural." },
  { title: "Spa e sauna", category: "Bem-estar", image: "11_spa_sauna.webp", caption: "Seu próprio tempo para desacelerar." },
  { title: "Brinquedoteca", category: "Infância", image: "12_brinquedoteca.webp", caption: "Um universo feito para descobrir." },
  { title: "Pet place", category: "Família", image: "13_pet_place.webp", caption: "Porque os companheiros de quatro patas também são parte da vida." },
  { title: "Espaços ao ar livre", category: "Convivência", image: "14_convivencia_ar_livre.webp", caption: "O prazer das conversas sem pressa." },
];

const navigation = [
  { text: "O Solaris", href: "#conceito" },
  { text: "Lazer", href: "#lazer" },
  { text: "Localização", href: "#localizacao" },
  { text: "Implantação", href: "#implantacao" },
];

function Arrow({ left = false }: { left?: boolean }) {
  return <span aria-hidden="true">{left ? "←" : "→"}</span>;
}

export function SolarisAlphaLanding() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryPosition, setGalleryPosition] = useState(0);
  const galleryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 80);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  const scrollGallery = (direction: -1 | 1) => {
    const node = galleryRef.current;
    const card = node?.firstElementChild as HTMLElement | null;
    if (!node || !card) return;
    const gap = Number.parseFloat(window.getComputedStyle(node).columnGap) || 20;
    node.scrollBy({ left: (card.getBoundingClientRect().width + gap) * direction, behavior: "smooth" });
  };

  const trackGallery = () => {
    const node = galleryRef.current;
    const card = node?.firstElementChild as HTMLElement | null;
    if (!node || !card) return;
    const gap = Number.parseFloat(window.getComputedStyle(node).columnGap) || 20;
    setGalleryIndex(Math.min(gallery.length - 1, Math.max(0, Math.round(node.scrollLeft / (card.getBoundingClientRect().width + gap)))));
    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
    setGalleryPosition(maxScroll ? Math.min(100, Math.max(0, Math.round(node.scrollLeft / maxScroll * 100))) : 0);
  };

  const seekGallery = (position: number) => {
    const node = galleryRef.current;
    if (!node) return;
    setGalleryPosition(position);
    node.scrollTo({ left: (node.scrollWidth - node.clientWidth) * position / 100, behavior: "auto" });
  };

  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#conteudo">Ir para o conteúdo</a>

      <header className={`${styles.header} ${scrolled || menuOpen ? styles.headerSolid : ""}`}>
        <a href="#inicio" className={styles.headerLogo} aria-label="Solaris Residencial Resort, voltar ao início" onClick={() => setMenuOpen(false)}>
          <Image src={`${editorial}/logo-solaris-oficial-v3.webp`} width={152} height={138} alt="Solaris Residencial Resort" priority />
        </a>
        <nav className={styles.navigation} aria-label="Navegação principal">
          {navigation.map(item => <a href={item.href} key={item.href}>{item.text}</a>)}
        </nav>
        <a href="#cadastro" className={styles.headerContact}>Quero conhecer <Arrow /></a>
        <button type="button" className={styles.menuButton} onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="solaris-nova-mobile-nav" aria-label={menuOpen ? "Fechar menu" : "Abrir menu"}>
          <span /><span /><span />
        </button>
        {menuOpen && <nav id="solaris-nova-mobile-nav" className={styles.mobileNavigation} aria-label="Navegação mobile">
          {navigation.map(item => <a href={item.href} key={item.href} onClick={() => setMenuOpen(false)}>{item.text}</a>)}
          <a href="#cadastro" onClick={() => setMenuOpen(false)}>Fale com a equipe <Arrow /></a>
        </nav>}
      </header>

      <main id="conteudo">
        <section id="inicio" className={styles.hero} aria-label="Apresentação do Solaris">
          <div className={styles.heroImage}>
            <Image src={`${editorial}/deck-represa-v7.webp`} alt="Represa em meio à natureza com deck de madeira, no cenário do Solaris" fill priority sizes="100vw" quality={88} />
          </div>
          <div className={styles.heroOverlay} />
          <div className={styles.heroContent}>
            <p className={styles.eyebrowLight}><span className={styles.goldLine} /> SOLARIS RESIDENCIAL RESORT · MONTE CARMELO/MG</p>
            <h1>Viva abraçado<br />pela <em>Natureza.</em><br />Viva no Solaris.</h1>
            <p className={styles.heroDescription}>Um lugar para viver o extraordinário que existe em cada dia.</p>
            <a href="#conceito" className={styles.heroButton}>Descubra o Solaris <Arrow /></a>
          </div>
          <div className={styles.heroFooter}>
            <span>01 <span className={styles.heroFooterRule} /> 07</span>
            <a href="#conceito">Role para descobrir <span aria-hidden="true">↓</span></a>
            <span>Imagens ilustrativas do empreendimento e do entorno</span>
          </div>
        </section>

        <section id="conceito" className={styles.introSection}>
          <div className={styles.container}>
            <div className={styles.introGrid}>
              <div className={styles.introCopy}>
                <span className={styles.eyebrow}>01 / UMA NOVA EXPERIÊNCIA DE MORAR</span>
                <h2>O privilégio de<br /><em>sentir-se em casa</em><br />com a natureza.</h2>
                <span className={styles.sectionRule} />
                <p className={styles.leadText}>Há lugares que mudam a forma como vivemos o tempo.</p>
                <p>O Solaris nasce no setor da represa, dentro do bairro planejado Parque das Árvores, em Monte Carmelo. Um residencial onde lazer, paisagem e encontros se conectam para criar uma rotina com mais significado.</p>
                <a href="#lazer" className={styles.textLink}>Explore as experiências <Arrow /></a>
              </div>
              <figure className={styles.introFigure}>
                <div className={styles.introImage}><Image src={`${book}/portaria.avif`} alt="Perspectiva arquitetônica da portaria do Solaris Residencial Resort" fill sizes="(max-width: 780px) 100vw, 52vw" quality={90} /></div>
                <figcaption>Portaria do Solaris · perspectiva ilustrativa do projeto</figcaption>
                <span className={styles.figureIndex}>SOLARIS / 01</span>
              </figure>
            </div>
            <div className={styles.factsStrip} aria-label="Destaques do Solaris">
              <div><strong>248</strong><span>lotes residenciais</span></div>
              <div><strong>360 <small>m²</small></strong><span>lotes a partir de</span></div>
              <div><strong>Monte Carmelo</strong><span>Minas Gerais</span></div>
              <div><strong>Natureza e lazer</strong><span>em um só endereço</span></div>
            </div>
          </div>
        </section>

        <section id="lazer" className={styles.leisureSection}>
          <div className={styles.container}>
            <div className={styles.leisureHeading}>
              <div><span className={styles.eyebrow}>02 / VIVER É APROVEITAR</span><h2>Lazer para a vida<br /><em>de todos os dias.</em></h2></div>
              <div className={styles.leisureHeadingRight}><p>Escolha seu ritmo. Os espaços de lazer e convivência do Solaris foram pensados para que cada dia tenha uma nova possibilidade.</p><div className={styles.carouselControls}><span className={styles.carouselCount}>{String(galleryIndex + 1).padStart(2, "0")} <span>/ {String(gallery.length).padStart(2, "0")}</span></span><button type="button" onClick={() => scrollGallery(-1)} disabled={galleryIndex === 0} aria-label="Imagem anterior"><Arrow left /></button><button type="button" onClick={() => scrollGallery(1)} disabled={galleryIndex === gallery.length - 1} aria-label="Próxima imagem"><Arrow /></button></div></div>
            </div>
          </div>
          <div className={styles.galleryTrack} ref={galleryRef} onScroll={trackGallery} tabIndex={0} aria-label="Galeria horizontal de lazer; role para os lados para ver todos os espaços">
            {gallery.map((item, index) => <article className={styles.galleryCard} key={item.image}>
              <div className={styles.galleryImage}><Image src={`${editorial}/lazer/${item.image}`} alt={`Imagem ilustrativa: ${item.title.toLowerCase()} no Solaris`} fill loading="lazy" sizes="(max-width: 760px) 82vw, (max-width: 1100px) 44vw, 32vw" /></div>
              <div className={styles.galleryOverlay} />
              <div className={styles.galleryTop}><span>{String(index + 1).padStart(2, "0")}</span><span>{item.category}</span></div>
              <div className={styles.galleryBottom}><h3>{item.title}</h3><p>{item.caption}</p></div>
            </article>)}
          </div>
          <div className={styles.galleryExplorer}>
            <div className={styles.galleryExplorerHeading}>
              <label htmlFor="solaris-lazer-explorar">Arraste para explorar <span aria-hidden="true">↔</span></label>
              <span className={styles.galleryExplorerCount}>{String(galleryIndex + 1).padStart(2, "0")} <small>/ {String(gallery.length).padStart(2, "0")}</small></span>
            </div>
            <div className={styles.gallerySeekControl}>
              <div className={styles.gallerySeekRail} aria-hidden="true"><span style={{ width: `${galleryPosition}%` }} /></div>
              <input id="solaris-lazer-explorar" type="range" min={0} max={100} value={galleryPosition} onChange={event => seekGallery(Number(event.currentTarget.value))} aria-label="Arraste para percorrer as imagens de lazer do Solaris" aria-valuetext={`Imagem ${galleryIndex + 1} de ${gallery.length}`} />
            </div>
            <p>Arraste o marcador ou deslize as fotos para ver todos os espaços. <span>Imagens conceituais e ilustrativas.</span></p>
          </div>
        </section>

        <section id="embaixador" className={styles.ambassadorSection} aria-labelledby="solaris-ambassador-title">
          <div className={styles.container}>
            <div className={styles.ambassadorGrid}>
              <figure className={styles.ambassadorVisual}>
                <div className={styles.ambassadorGlow} aria-hidden="true" />
                <Image src={`${editorial}/leo-chaves-embaixador.webp`} alt="Léo Chaves, embaixador do Solaris Residencial Resort" fill sizes="(max-width: 780px) 92vw, 43vw" quality={88} />
                <figcaption>Foto de Léo Chaves · embaixador do Solaris</figcaption>
              </figure>
              <div className={styles.ambassadorCopy}>
                <span className={styles.eyebrow}>UMA CONEXÃO COM O QUE IMPORTA</span>
                <p className={styles.ambassadorRole}>EMBAIXADOR DO SOLARIS RESIDENCIAL RESORT</p>
                <h2 id="solaris-ambassador-title">Léo Chaves.<br /><em>Viver de verdade</em><br />é o que importa.</h2>
                <span className={styles.sectionRule} />
                <p>O Solaris tem Léo Chaves como embaixador. Um encontro entre a valorização das boas histórias e a proposta de viver mais perto da natureza, dos afetos e de tudo aquilo que torna a vida especial.</p>
                <a href="#cadastro" className={styles.textLink}>Venha viver essa história <Arrow /></a>
              </div>
            </div>
          </div>
        </section>

        <section id="natureza" className={styles.natureSection}>
          <div className={styles.natureImage}><Image src={`${editorial}/paisagem-aerea.webp`} fill sizes="100vw" alt="Paisagem aérea do Cerrado mineiro com represa e luz do fim de tarde" /></div>
          <div className={styles.natureShade} />
          <div className={styles.container}><div className={styles.natureContent}>
            <span className={styles.eyebrowLight}><span className={styles.goldLine} /> 03 / A NATUREZA FAZ PARTE</span>
            <h2>Um horizonte que<br />muda tudo. <em>Todos os dias.</em></h2>
            <p>Mais do que estar perto do verde, o Solaris convida você a incorporá-lo à sua maneira de viver: caminhadas, contemplação e encontros que merecem durar um pouco mais.</p>
            <a className={styles.linkLight} href="#localizacao">Conheça a localização <Arrow /></a>
          </div></div>
          <span className={styles.natureCaption}>Paisagem do entorno · imagem ilustrativa</span>
        </section>

        <section id="localizacao" className={styles.locationSection}>
          <div className={styles.container}>
            <div className={styles.locationGrid}>
              <div className={styles.locationImages}><figure className={styles.locationPrimary}><Image src={`${editorial}/parque-linear-v3.webp`} fill sizes="(max-width: 780px) 100vw, 52vw" alt="Caminho arborizado e ciclovia no Parque Linear" /><figcaption>Parque Linear · imagem ilustrativa</figcaption></figure><div className={styles.locationTag}>PARQUE DAS ÁRVORES<br /><span>MONTE CARMELO / MG</span></div></div>
              <div className={styles.locationCopy}>
                <span className={styles.eyebrow}>04 / ONDE TUDO SE ENCONTRA</span>
                <h2>Um novo jeito<br />de estar <em>perto de tudo.</em></h2>
                <p>O Solaris faz parte do Parque das Árvores, um bairro planejado para formar uma nova centralidade em Monte Carmelo. É a combinação da tranquilidade da natureza com a perspectiva de uma vizinhança viva.</p>
                <div className={styles.locationPoints}>
                  <div><span>01</span><div><strong>Em Monte Carmelo</strong><small>Um endereço pensado para o presente e o futuro da cidade.</small></div></div>
                  <div><span>02</span><div><strong>Setor da represa</strong><small>Uma paisagem especial como parte da experiência de morar.</small></div></div>
                  <div><span>03</span><div><strong>Bairro Parque das Árvores</strong><small>Conectado à proposta de um novo bairro planejado.</small></div></div>
                </div>
                <a className={styles.textLink} href="#cadastro">Saiba mais sobre o endereço <Arrow /></a>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.infrastructureSection}>
          <div className={styles.container}>
            <div className={styles.infrastructureHeader}><span className={styles.eyebrowLight}><span className={styles.goldLine} /> 05 / PENSADO EM CADA DETALHE</span><h2>A tranquilidade de<br />viver com <em>mais possibilidades.</em></h2></div>
            <div className={styles.infrastructureGrid}>
              <div><span>01</span><strong>Controle de acesso</strong><p>Uma portaria projetada para organizar o acesso e valorizar a chegada ao residencial.</p></div>
              <div><span>02</span><strong>Infraestrutura moderna</strong><p>Projeto com redes elétricas subterrâneas e iluminação em LED.</p></div>
              <div><span>03</span><strong>Áreas de convivência</strong><p>Espaços pensados para lazer, encontros e qualidade de vida ao longo do ano.</p></div>
            </div>
            <p className={styles.infrastructureNote}>Características previstas em projeto; consulte memorial descritivo e condições de implantação.</p>
          </div>
        </section>

        <section id="implantacao" className={styles.masterplanSection}>
          <div className={styles.container}>
            <div className={styles.masterplanHeader}><div><span className={styles.eyebrow}>06 / CONHEÇA CADA DETALHE</span><h2>Seu lugar no<br /><em>Solaris.</em></h2></div><div><p>Descubra o desenho do residencial, a distribuição dos lotes e a relação com as áreas verdes e de lazer.</p><a href={`${editorial}/humanizado-solaris-v3.webp`} target="_blank" rel="noopener noreferrer" className={styles.textLink}>Ampliar implantação <span aria-hidden="true">↗</span></a></div></div>
            <a className={styles.masterplanImage} href={`${editorial}/humanizado-solaris-v3.webp`} target="_blank" rel="noopener noreferrer" aria-label="Abrir a implantação ilustrativa do Solaris em tamanho maior"><Image src={`${editorial}/humanizado-solaris-v3.webp`} fill sizes="(max-width: 780px) 100vw, 90vw" alt="Implantação humanizada do Solaris Residencial Resort e das áreas de entorno" /><span>AMPLIAR IMPLANTAÇÃO <span aria-hidden="true">↗</span></span></a>
            <p className={styles.masterplanDisclaimer}>Implantação humanizada ilustrativa. Confira a planta oficial, o memorial descritivo e as condições de cada lote com a equipe comercial.</p>
          </div>
        </section>

        <section id="cadastro" className={styles.contactSection}>
          <div className={styles.container}>
            <div className={styles.contactGrid}>
              <div className={styles.contactCopy}>
                <span className={styles.eyebrowLight}><span className={styles.goldLine} /> 07 / SEU PRÓXIMO CAPÍTULO</span>
                <h2>O melhor lugar<br />para os seus <em>novos dias.</em></h2>
                <p>Converse com a equipe e descubra os lotes disponíveis, as possibilidades de pagamento e a experiência de viver no Solaris.</p>
                <div className={styles.contactArt}><Image src={`${editorial}/estande-solaris-v3.webp`} fill sizes="(max-width: 780px) 100vw, 44vw" alt="Estande de atendimento do Solaris Residencial Resort" /></div>
                <small>Imagem ilustrativa do estande de atendimento.</small>
              </div>
              <div className={styles.contactForm}><SolarisCaptureForm /></div>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.container}>
          <div className={styles.footerMain}>
            <a href="#inicio" className={styles.footerLogo}><Image src={`${editorial}/logo-solaris-oficial-v3.webp`} width={150} height={138} alt="Solaris Residencial Resort" /></a>
            <div><span>RESIDENCIAL RESORT</span><p>Viva abraçado pela Natureza.<br />Viva no Solaris.</p></div>
            <a className={styles.footerCta} href="#cadastro">Quero conhecer o Solaris <Arrow /></a>
          </div>
          <div className={styles.footerBottom}><p>Solaris Residencial Resort · Monte Carmelo, MG.<br />Imagens e perspectivas meramente ilustrativas. Consulte os documentos oficiais, as características e condições comerciais vigentes.</p><div><a href="/privacidade">Privacidade</a><a href="#inicio">Voltar ao topo ↑</a></div><Image src={`${book}/evora.avif`} alt="Évora Urbanismo" width={143} height={40} /></div>
        </div>
      </footer>

      <a className={styles.floatingContact} href="#cadastro" aria-label="Quero conhecer o Solaris"><span className={styles.floatingGlyph} aria-hidden="true">✦</span><span>CONHEÇA O SOLARIS</span></a>
    </div>
  );
}
