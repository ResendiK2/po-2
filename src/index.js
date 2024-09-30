// src/index.js

const fs = require("fs");
const path = require("path");
const glpkModule = require("glpk.js");
const PDFDocument = require("pdfkit");

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
  // x_d_D_H = 1 se o desenvolvedor d trabalha no dia D na hora H
  // Para simplificação, usaremos variáveis binárias

  // Mapeamento de dias para números
  const dayNames = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const dayToNumber = {};
  dayNames.forEach((day, index) => {
    dayToNumber[day] = index + 1;
  });

  let variables = [];
  let objectiveVars = [];
  let objectiveCoefficients = [];

  // Coletar todas as variáveis e seus coeficientes
  developers.forEach((dev) => {
    const wc = weekly_constraints.find(
      (wc) => wc.DeveloperID === dev.DeveloperID
    );
    if (!wc) return; // Se não houver restrição semanal para o desenvolvedor, pular

    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        // Verificar se o desenvolvedor pode trabalhar neste horário
        let canWork = true;

        // Desenvolvedores Juniores têm restrições
        if (dev.Level === "Junior") {
          if (day > 5) {
            // Sábado e Domingo
            canWork = false;
          } else if (hour < 8 || hour >= 17) {
            canWork = false;
          }
        }

        // Adicionar restrição de almoço para juniores
        // Exclusivo para juniores: não trabalham entre 12:00-13:00
        if (dev.Level === "Junior" && day <= 5 && hour === 12) {
          canWork = false;
        }

        if (canWork) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          variables.push(varName);
          objectiveVars.push(varName);
          objectiveCoefficients.push(dev.CostPerHour);
        }
      }
    }
  });

  // Definir a função objetivo
  let model = {
    name: "Developer Scheduling",
    objective: {
      direction: GLPK.GLP_MIN,
      name: "Total_Cost",
      vars: [],
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

  // Adicionar restrições

  // 1. Cobertura 24x7: cada hora deve ter pelo menos um desenvolvedor alocado
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
        // Verificar se o desenvolvedor pode trabalhar neste horário
        let canWork = true;

        if (dev.Level === "Junior") {
          if (day > 5) {
            // Sábado e Domingo
            canWork = false;
          } else if (hour < 8 || hour >= 17) {
            canWork = false;
          }

          // Restringir o horário de almoço para juniores
          if (dev.Level === "Junior" && day <= 5 && hour === 12) {
            canWork = false;
          }
        }

        if (canWork) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // 2. Cobertura durante Horas Ativas (08h às 17h, Segunda a Sexta)
  // Pelo menos 2 plenos ou 1 sênior em cada hora ativa
  for (let day = 1; day <= 5; day++) {
    // Segunda a Sexta
    for (let hour = 8; hour < 17; hour++) {
      // 08h às 17h
      let constraint = {
        name: `active_coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_LO,
          lb: 2,
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

  // 3. Cada desenvolvedor deve ter entre 40 e 52 horas semanais
  developers.forEach((dev) => {
    const wc = weekly_constraints.find(
      (wc) => wc.DeveloperID === dev.DeveloperID
    );
    if (!wc) return; // Se não houver restrição semanal para o desenvolvedor, pular

    // Soma das horas atribuídas ao desenvolvedor
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
        // Verificar se o desenvolvedor pode trabalhar neste horário
        let canWork = true;

        if (dev.Level === "Junior") {
          if (day > 5) {
            // Sábado e Domingo
            canWork = false;
          } else if (hour < 8 || hour >= 17) {
            canWork = false;
          }

          // Restringir o horário de almoço para juniores
          if (dev.Level === "Junior" && day <= 5 && hour === 12) {
            canWork = false;
          }
        }

        if (canWork) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          sumHours.vars.push({ name: varName, coef: 1 });
        }
      }
    }

    model.subjectTo.push(sumHours);
  });

  // 4. Restrições para Juniors: trabalhar de segunda a sexta de 8h às 17h com almoço das 12h às 13h
  developers.forEach((dev) => {
    if (dev.Level === "Junior") {
      for (let day = 1; day <= 5; day++) {
        // Segunda a Sexta
        for (let hour = 8; hour < 17; hour++) {
          // 08h às 17h
          if (hour === 12) continue; // Hora de almoço

          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;

          // Forçar a variável a ser 1 (juniores devem trabalhar neste horário)
          model.subjectTo.push({
            name: `junior_work_D${day}_H${hour}_Dev${dev.DeveloperID}`,
            vars: [{ name: varName, coef: 1 }],
            bnds: {
              type: GLPK.GLP_FX,
              lb: 1,
              ub: 1,
            },
          });
        }

        // Restringir a hora de almoço
        const lunchVar = `x_${dev.DeveloperID}_D${day}_H12`;
        model.subjectTo.push({
          name: `junior_lunch_D${day}_Dev${dev.DeveloperID}`,
          vars: [{ name: lunchVar, coef: 1 }],
          bnds: {
            type: GLPK.GLP_FX,
            lb: 0,
            ub: 0,
          },
        });
      }
    }
  });

  // 5. Restrições de Deploy: apenas seniores podem realizar deploys
  deploys.forEach((deploy) => {
    const deployDate = new Date(deploy.Date);
    const deployDay = deployDate.getDay(); // 0 = Sunday, 6 = Saturday
    // Mapear para o nosso sistema (1=Monday, ..., 7=Sunday)
    const mappedDay = deployDay === 0 ? 7 : deployDay;

    const deployHour = parseInt(deploy.Time.split(":")[0], 10);

    // Somente seniores podem estar trabalhando neste horário
    developers.forEach((dev) => {
      if (dev.Level !== "Sênior") {
        const varName = `x_${dev.DeveloperID}_D${mappedDay}_H${deployHour}`;
        model.subjectTo.push({
          name: `deploy_no_non_senior_D${mappedDay}_H${deployHour}_Dev${dev.DeveloperID}`,
          vars: [{ name: varName, coef: 1 }],
          bnds: {
            type: GLPK.GLP_FX,
            lb: 0,
            ub: 0,
          },
        });
      }
    });
  });

  // 6. Limitar horas extras (acima de 40 horas)
  // Neste modelo simplificado, já limitamos as horas a 52, mas não distinguimos horas extras.
  // Para implementar horas extras, precisaríamos adicionar variáveis adicionais.

  // Retornar o modelo
  return model;
}

// Função para resolver o modelo GLPK
async function solveGLPKModel(model, GLPK) {
  try {
    const result = GLPK.solve(model, GLPK.GLP_MSG_OFF);
    return result;
  } catch (error) {
    console.error("Erro ao resolver o modelo GLPK:", error);
    throw error;
  }
}

// Função para gerar o relatório PDF
function generatePDFReport(solution, inputData) {
  const doc = new PDFDocument({ margin: 30, size: "A4" });
  const outputPath = path.join(__dirname, "..", "schedule_report.pdf");
  doc.pipe(fs.createWriteStream(outputPath));

  // Título do Relatório
  doc.fontSize(20).text("Relatório de Escalas", { align: "center" });
  doc.moveDown();

  // Período de Agendamento
  doc
    .fontSize(14)
    .text(`Mês: ${inputData.scheduling_period.month}`, { align: "left" });
  doc.moveDown();

  // Estrutura para armazenar a escala
  const schedule = {};

  if (!solution.result || !solution.result.vars) {
    doc.fontSize(12).text("Nenhuma solução encontrada.", { align: "left" });
    doc.end();
    return;
  }

  // Processar as variáveis da solução
  for (const [varName, value] of Object.entries(solution.result.vars)) {
    if (value === 1) {
      // varName no formato x_{DeveloperID}_D{day}_H{hour}
      const regex = /^x_(\d+)_D(\d+)_H(\d+)$/;
      const match = varName.match(regex);
      if (match) {
        const devID = parseInt(match[1], 10);
        const dayNum = parseInt(match[2], 10);
        const hour = parseInt(match[3], 10);

        if (!schedule[devID]) {
          schedule[devID] = {};
        }

        const dayName = [
          "Segunda",
          "Terça",
          "Quarta",
          "Quinta",
          "Sexta",
          "Sábado",
          "Domingo",
        ][dayNum - 1];

        if (!schedule[devID][dayName]) {
          schedule[devID][dayName] = [];
        }

        schedule[devID][dayName].push(hour);
      }
    }
  }

  // Organizar as escalas por desenvolvedor
  const developers = inputData.developers;
  const weeklyHours = {};
  const weeklyCost = {};

  developers.forEach((dev) => {
    weeklyHours[dev.DeveloperID] = 0;
    weeklyCost[dev.DeveloperID] = 0;
  });

  // Gerar a tabela de escalas
  developers.forEach((dev) => {
    doc
      .fontSize(16)
      .fillColor("black")
      .text(`Desenvolvedor: ${dev.Name} (${dev.Level})`, { underline: true });
    doc.moveDown(0.5);

    const devSchedule = schedule[dev.DeveloperID];
    if (devSchedule) {
      // Criar uma tabela simples
      doc.fontSize(12).fillColor("black");

      Object.entries(devSchedule).forEach(([day, hours]) => {
        // Ordenar as horas
        hours.sort((a, b) => a - b);

        // Agrupar horas contínuas
        const timeRanges = [];
        let start = hours[0];
        let end = hours[0];

        for (let i = 1; i < hours.length; i++) {
          if (hours[i] === end + 1) {
            end = hours[i];
          } else {
            timeRanges.push({ start, end });
            start = hours[i];
            end = hours[i];
          }
        }
        timeRanges.push({ start, end });

        // Formatar os horários
        const formattedRanges = timeRanges
          .map((range) => `${range.start}:00 - ${range.end + 1}:00`)
          .join(", ");

        // Adicionar ao PDF
        doc.text(`${day}: ${formattedRanges}`);

        // Calcular horas trabalhadas (cada intervalo representa (end - start +1) horas)
        const hoursWorked = timeRanges.reduce(
          (acc, range) => acc + (range.end - range.start + 1),
          0
        );
        weeklyHours[dev.DeveloperID] += hoursWorked;

        // Calcular custo
        weeklyCost[dev.DeveloperID] += hoursWorked * dev.CostPerHour;
      });
    } else {
      doc.text("Nenhuma alocação.");
    }

    doc.moveDown();
  });

  // Resumo das Horas e Custos
  doc
    .fontSize(16)
    .fillColor("black")
    .text("Resumo de Horas e Custos", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor("black");

  // Tabela de Resumo
  const tableTop = doc.y;
  const itemIndent = 50;
  const col1 = 50;
  const col2 = 200;
  const col3 = 350;
  const col4 = 450;

  // Cabeçalhos da Tabela
  doc.text("Desenvolvedor", col1, tableTop, { bold: true });
  doc.text("Horas Trabalhadas", col2, tableTop);
  doc.text("Custo (R$)", col3, tableTop);
  doc.moveDown(0.5);

  developers.forEach((dev) => {
    const y = doc.y;
    doc.text(dev.Name, col1, y);
    doc.text(weeklyHours[dev.DeveloperID], col2, y);
    doc.text(weeklyCost[dev.DeveloperID].toFixed(2), col3, y);
    doc.moveDown(0.3);
  });

  // Custo Total
  const totalCost = Object.values(weeklyCost).reduce(
    (acc, curr) => acc + curr,
    0
  );
  doc.moveDown(1);
  doc
    .fontSize(14)
    .fillColor("black")
    .text(`Custo Total: R$ ${totalCost.toFixed(2)}`, { align: "right" });

  // Finalizar o PDF
  doc.end();
  console.log(`Relatório gerado em: ${outputPath}`);
}

// Função principal
async function main() {
  try {
    const inputFilePath = path.join(__dirname, "input_data.json");
    const inputData = readInputData(inputFilePath);

    const GLPK = await glpkModule(); // Inicializa o GLPK

    const model = generateGLPKModel(inputData, GLPK);

    console.log("Modelo GLPK gerado.");

    const solution = solveGLPKModel(model, GLPK);

    solution
      .then((result) => {
        if (result.result.status === GLPK.GLP_OPT) {
          console.log("Solução ótima encontrada.");
          generatePDFReport(result, inputData);
        } else {
          console.log("Não foi possível encontrar uma solução ótima.");
          console.log(`Status da solução: ${result.result.status}`);
        }
      })
      .catch((error) => {
        console.error("Erro ao resolver o modelo GLPK:", error);
      });
  } catch (error) {
    console.error("Erro:", error);
  }
}

main();
