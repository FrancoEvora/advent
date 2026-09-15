import Image from "next/image";
import { SolarisBookLink } from "./SolarisBookLink";
import styles from "./solaris-form.module.css";
import updates from "./solaris-updates.module.css";
import downloads from "./solaris-downloads.module.css";

// Transcrição da mensagem fornecida no Book Comercial Solaris 2026 V6, página 2.
// Não é um depoimento criado para esta página.
export function SolarisAmbassador() {
  return (
    <section className={`${styles.section} ${updates.ambassadorSection}`} id="embaixador" aria-labelledby="embaixador-titulo">
      <div className={updates.ambassadorGrid}>
        <figure className={updates.portraitFigure}>
          <Image src="/forms/solaris/book/leo-chaves-embaixador.avif" alt="Leo Chaves, embaixador da Évora Urbanismo, na apresentação do Solaris." width={560} height={718} unoptimized loading="lazy" />
        </figure>
        <div className={updates.ambassadorCopy}>
          <p className={styles.eyebrow}>MENSAGEM DO EMBAIXADOR</p>
          <h2 id="embaixador-titulo">Uma nova forma<br />de <em>viver bem.</em></h2>
          <span className={updates.quoteMark} aria-hidden="true">“</span>
          <figure className={updates.testimonial}>
            <blockquote>
              <p>A vida é feita de momentos simples e verdadeiros. Estar perto da família, compartilhar bons encontros e sentir a paz de um lugar que inspira bem-estar é o que realmente importa.</p>
              <p>O Solaris nasce com esse espírito: um convite para viver com mais leveza, conexão e qualidade de vida.</p>
            </blockquote>
            <figcaption className={updates.signature}>
              <strong>Leo Chaves</strong>
              <span>Embaixador Évora Urbanismo</span>
            </figcaption>
          </figure>
          <p className={updates.sourceNote}>Mensagem publicada no book comercial Solaris · Página 2</p>
          <div className={downloads.ambassadorActions}>
            <a className={styles.goldButton} href="#formulario">Receber lotes e condições <span aria-hidden="true">→</span></a>
            <SolarisBookLink className={downloads.secondaryDownload}>Baixar book completo (PDF)</SolarisBookLink>
          </div>
          <p className={downloads.downloadMeta}>23 páginas · 32 MB · Download livre, sem cadastro</p>
        </div>
      </div>
    </section>
  );
}
