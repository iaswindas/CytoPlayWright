export class LoginPage {
  open() {
    cy.visit("/login");
  }

  enterUsername(username: string) {
    cy.get("[data-testid='username']").type(username);
  }

  enterPassword(password: string) {
    cy.get("[data-testid='password']").type(password);
  }

  submit() {
    cy.get("[data-testid='submit']").click();
  }

  usernameField() {
    return cy.get("[data-testid='username']");
  }
}
