// src/index.js

const fs = require("fs");
const path = require("path");
const glpkModule = require("glpk.js");
const { generatePDFReport } = require("./pdf");

// Função para ler e parsear o JSON de entrada
function readInputData(filePath) {
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data);
}

// Função para gerar o modelo GLPK
function generateGLPKModel(inputData, GLPK) {
  const {
    developers,
    weekly_constraints,
    constraints_rules,
    additional_constraints,
    deploys,
  } = inputData;

  // Definir as variáveis de decisão
  let variables = [];
  let objectiveVars = [];
  let objectiveCoefficients = [];

  // Função para verificar se um desenvolvedor pode trabalhar em determinado dia e hora
  function canWork(dev, day, hour) {
    if (day > 5) {
      return dev.Level !== "Junior"; // Apenas Pleno ou Sênior podem estar de sobreaviso
    }
    if (dev.Level === "Junior") {
      return hour >= 8 && hour < 17; // Juniores só podem trabalhar das 8h às 17h
    }
    return true;
  }

  // Coletar todas as variáveis e seus coeficientes
  developers.forEach((dev) => {
    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (canWork(dev, day, hour)) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          variables.push(varName);

          // Cálculo do custo por hora ativo, hora extra ou sobreaviso
          if (hour >= 8 && hour < 17 && day <= 5) { // Horário ativo
            objectiveCoefficients.push(dev.CostPerHour);
          } else if (hour < 8 || hour >= 17) { // Horário de sobreaviso
            objectiveCoefficients.push(dev.CostPerHour * constraints_rules.OnCallRate);
          } else { // Hora extra
            objectiveCoefficients.push(dev.CostPerHour * constraints_rules.OvertimeRate);
          }

          objectiveVars.push(varName);
        }
      }
    }
  });

  // Definir a função objetivo
  const model = {
    name: "Developer Scheduling",
    objective: {
      direction: GLPK.GLP_MIN,
      name: "Total_Cost",
      vars: [],
      bnds: {
        type: GLPK.GLP_FX,
        lb: 0,
        ub: 0,
      },
    },
    subjectTo: [],
    binaries: variables,
    generals: [],
  };

  // Adicionar as variáveis e coeficientes à função objetivo
  objectiveVars.forEach((varName, index) => {
    model.objective.vars.push({
      name: varName,
      coef: objectiveCoefficients[index],
    });
  });

  // Restrições

  // 1. Cobertura 24x7: cada hora deve ter pelo menos um desenvolvedor trabalhando
  for (let day = 1; day <= 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      let constraint = {
        name: `coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_LO,
          lb: 1,
          ub: 0,
        },
      };

      developers.forEach((dev) => {
        if (canWork(dev, day, hour)) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // 2. Cada desenvolvedor deve ter entre 40 e 52 horas semanais
  developers.forEach((dev) => {
    const wc = weekly_constraints.find(
      (wc) => wc.DeveloperID === dev.DeveloperID
    );

    let sumHours = {
      name: `sum_hours_dev_${dev.DeveloperID}`,
      vars: [],
      bnds: {
        type: GLPK.GLP_DB,
        lb: wc.MinimumWeeklyHours,
        ub: wc.MaximumWeeklyHours,
      },
    };

    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (canWork(dev, day, hour)) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          sumHours.vars.push({ name: varName, coef: 1 });
        }
      }
    }

    model.subjectTo.push(sumHours);
  });

  // 3. Cobertura durante Horas Ativas
  for (let day = 1; day <= 5; day++) {
    for (let hour = 8; hour < 17; hour++) {
      let constraint = {
        name: `active_coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_LO,
          lb: constraints_rules.MinimumSupportDuringActiveHours.PlentosRequired,
          ub: 0,
        },
      };

      developers.forEach((dev) => {
        if (dev.Level === "Pleno" || dev.Level === "Sênior") {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // 4. Finais de Semana: Apenas sobreaviso
  for (let day = 6; day <= 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      let constraint = {
        name: `weekend_coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_FX,
          lb: additional_constraints.weekend_coverage.developers_required_per_day,
          ub: additional_constraints.weekend_coverage.developers_required_per_day,
        },
      };

      developers.forEach((dev) => {
        if (dev.Level !== "Junior") {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // 5. Plantão da madrugada (apenas para seniores)
  deploys.forEach((deploy) => {
    const deployDay = new Date(deploy.Date).getDay();
    const deployHour = new Date(`1970-01-01T${deploy.Time}:00`).getHours();

    let constraint = {
      name: `deploy_coverage_D${deployDay}_H${deployHour}`,
      vars: [],
      bnds: {
        type: GLPK.GLP_FX,
        lb: 1,
        ub: 1,
      },
    };

    developers.forEach((dev) => {
      if (dev.Level === "Sênior") {
        const varName = `x_${dev.DeveloperID}_D${deployDay}_H${deployHour}`;
        constraint.vars.push({ name: varName, coef: 1 });
      }
    });

    model.subjectTo.push(constraint);
  });

  return model;
}


// Função principal para executar o modelo GLPK
function runScheduling(filePath) {
  const inputData = readInputData(filePath);

  // Inicializar GLPK
  const glpk = glpkModule();

  const model = generateGLPKModel(inputData, glpk);

  // Resolver o modelo
  const result = glpk.solve(model);

  // Gerar o relatório PDF
  generatePDFReport(result, inputData);

  console.log("Scheduling completed. Report generated.");
}

// Executar a aplicação
const inputFilePath = path.join(__dirname, "input_data.json");
runScheduling(inputFilePath);
