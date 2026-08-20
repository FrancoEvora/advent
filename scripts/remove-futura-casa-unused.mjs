import fs from "node:fs";

const file = "src/components/public-agent/PublicAgentExperience.tsx";
const before = fs.readFileSync(file, "utf8");
const obsolete = `  const project = experience.name?.normalize("NFC").trim();
  const destination = project && project !== "Évora Urbanismo"
    ? \` ou ainda conhecendo o \${project}\`
    : " ou ainda conhecendo as opções da Évora";
`;
if (!before.includes(obsolete)) throw new Error("Bloco obsoleto da saudação não encontrado");
fs.writeFileSync(file, before.replace(obsolete, ""), "utf8");
