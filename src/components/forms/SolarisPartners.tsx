import Image from "next/image";
import styles from "./solaris-downloads.module.css";

// Logos cropped from the campaign artwork supplied by the user, not recreated.
const partners = [
  { id: "jvf", role: "FINANCIAMENTO", name: "JVF Group", image: "logo-jvf.webp", width: 206, height: 84 },
  { id: "evora", role: "DESENVOLVIMENTO E INFRAESTRUTURA", name: "Évora Urbanismo", image: "logo-evora.webp", width: 248, height: 84 },
  { id: "zenith", role: "PARCERIA", name: "Zenith Empreendimentos", image: "logo-zenith.webp", width: 165, height: 102 },
];

export function SolarisPartners() {
  return (
    <section className={styles.partnerStrip} id="parceiros" aria-label="Empresas participantes do Solaris">
      <div className={styles.partnerGrid}>
        {partners.map(partner => (
          <div className={styles.partnerItem} key={partner.id} data-partner={partner.id}>
            <p className={styles.partnerRole}>{partner.role}</p>
            <div className={styles.partnerLogo}>
              <Image src={`/forms/solaris/book/${partner.image}`} alt={partner.name} width={partner.width} height={partner.height} unoptimized loading="lazy" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
