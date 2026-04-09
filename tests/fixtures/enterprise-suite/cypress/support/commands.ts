Cypress.Commands.add("loginAs", (role: string) => {
  cy.visit(`/internal-login/${role}`);
});
