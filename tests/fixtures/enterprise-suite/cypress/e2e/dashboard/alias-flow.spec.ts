describe("Alias value flow", () => {
  beforeEach(() => {
    cy.visit("/dashboard/alias-flow");
  });

  it("supports fixture aliases and then callbacks", () => {
    cy.fixture("user.json").as("user");
    cy.get("@user").then((user) => {
      cy.get("[data-testid='username']").type(user.username);
      cy.contains(user.username).should("be.visible");
    });
  });
});
