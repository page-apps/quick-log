export const STANDARD_SECURITY_DISCLOSURE =
  "This personal app stores a GitHub credential in your browser. A security flaw in this app, one of its dependencies, or another app on the same origin may expose that credential and every repository it can access. Use a fine-grained, expiring token limited to your personal app repositories and minimum permissions. Do not use this design for sensitive multi-user applications.";

export const SECURITY_DISCLOSURE = STANDARD_SECURITY_DISCLOSURE;

export function createSecurityDisclosureElement(document: Document): HTMLElement {
  const aside = document.createElement("aside");
  aside.dataset.repoAppSecurityDisclosure = "";
  aside.setAttribute("role", "note");
  const title = document.createElement("strong");
  title.textContent = "Credential security";
  const paragraph = document.createElement("p");
  paragraph.textContent = STANDARD_SECURITY_DISCLOSURE;
  aside.append(title, paragraph);
  return aside;
}
