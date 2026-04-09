describe("Dashboard API mock", () => {
  beforeEach(() => {
    cy.intercept("GET", "/api/items", {
      statusCode: 200,
      body: [{ id: 1, name: "Mocked Item" }]
    }).as("getItemsStub");

    cy.intercept("POST", "/api/items", {
      statusCode: 201,
      body: { id: 2, name: "Created Item" }
    }).as("createItemStub");

    cy.visit("/dashboard/items");
  });

  it("renders mocked items from stubbed API", () => {
    cy.get("[data-testid='item-row']").should("have.length", 1);
    cy.get("[data-testid='item-row']").first().should("contain.text", "Mocked Item");
  });

  it("creates an item and verifies the stub response", () => {
    cy.get("[data-testid='add-item-btn']").click();
    cy.get("[data-testid='item-name-input']").type("New Item");
    cy.get("[data-testid='submit-item']").click();
    cy.get("[data-testid='item-row']").should("have.length", 2);
  });

  it("handles navigation commands", () => {
    cy.url().should("contain", "/dashboard");
    cy.title().should("contain", "Dashboard");
    cy.reload();
    cy.go("back");
    cy.viewport(1920, 1080);
  });

  it("handles DOM traversal commands", () => {
    cy.get("[data-testid='item-list']").children().should("have.length.greaterThan", 0);
    cy.get("[data-testid='item-row']").first().parent().should("exist");
    cy.get("[data-testid='item-row']").eq(0).should("be.visible");
    cy.get("[data-testid='item-row']").last().should("exist");
  });

  it("handles action commands", () => {
    cy.get("[data-testid='item-row']").first().dblclick();
    cy.get("[data-testid='context-menu']").rightclick();
    cy.get("[data-testid='item-name-input']").clear().type("Updated");
    cy.get("[data-testid='item-name-input']").focus();
    cy.get("[data-testid='item-name-input']").blur();
    cy.get("[data-testid='item-row']").first().trigger("mouseover");
    cy.get("[data-testid='item-row']").first().scrollIntoView();
  });

  it("handles invoke and its commands", () => {
    cy.get("[data-testid='item-row']").first().invoke("text").should("contain", "Item");
    cy.get("[data-testid='item-name-input']").invoke("val").should("be.empty");
    cy.get("[data-testid='primary-link']").invoke("attr", "href").should("contain", "/dashboard");
  });

  it("checks form state assertions", () => {
    cy.get("[data-testid='submit-item']").should("be.disabled");
    cy.get("[data-testid='item-name-input']").type("test");
    cy.get("[data-testid='submit-item']").should("be.enabled");
    cy.get("[data-testid='checkbox']").should("not.be.checked");
    cy.get("[data-testid='checkbox']").check();
    cy.get("[data-testid='checkbox']").should("be.checked");
    cy.get("[data-testid='item-name-input']").should("have.attr", "placeholder", "Enter name");
    cy.get("[data-testid='item-row']").should("have.class", "active");
    cy.get("[data-testid='item-row']").should("have.css", "display", "flex");
  });
});
