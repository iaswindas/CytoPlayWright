import { LoginPage } from "../../page-objects/login.page";
import { goToDashboard } from "../../support/helpers/navigation";

describe("Login journey", () => {
  const loginPage = new LoginPage();

  beforeEach(() => {
    cy.visit("/login");
  });

  it("allows a standard user to authenticate", () => {
    const user = cy.fixture("user.json");
    loginPage.enterUsername(user.username);
    loginPage.enterPassword(user.password);
    loginPage.submit();
    goToDashboard();
    cy.contains("Welcome back").should("be.visible");
  });
});
